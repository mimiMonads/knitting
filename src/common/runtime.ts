type RuntimeName = "deno" | "bun" | "node" | "unknown";

type GlobalWithRuntimes = typeof globalThis & {
  Deno?: { version?: { deno?: string } };
  Bun?: { version?: string };
  setImmediate?: (cb: () => void) => void;
  navigator?: { userAgent?: string };
  document?: unknown;
  WorkerGlobalScope?: unknown;
};

const globals = globalThis as GlobalWithRuntimes;

export const IS_DENO = typeof globals.Deno?.version?.deno === "string";
export const IS_BUN = typeof globals.Bun?.version === "string";
export const IS_NODE =
  typeof process !== "undefined" && typeof process.versions?.node === "string";
export const IS_BROWSER =
  !IS_DENO &&
  !IS_BUN &&
  !IS_NODE &&
  (
    typeof globals.document !== "undefined" ||
    typeof globals.navigator !== "undefined" ||
    typeof globals.WorkerGlobalScope === "function"
  );

export const RUNTIME = (
  IS_DENO ? "deno" : IS_BUN ? "bun" : IS_NODE ? "node" : "unknown"
) as RuntimeName;

export const SET_IMMEDIATE =
  typeof globals.setImmediate === "function" ? globals.setImmediate : undefined;

const WASM_MEMORY_PAGE_BYTES = 64 * 1024;

type SharedArrayBufferWithGrow = SharedArrayBuffer & {
  grow?: (newByteLength: number) => void;
  growable?: boolean;
  maxByteLength?: number;
};

const wasmSharedBufferMemory = new WeakMap<SharedArrayBuffer, WebAssembly.Memory>();
const wasmSharedBufferMaxByteLength = new WeakMap<SharedArrayBuffer, number>();

const hasSharedWasmMemory = (() => {
  if (typeof WebAssembly?.Memory !== "function") return false;
  try {
    void new WebAssembly.Memory({ initial: 0, maximum: 1, shared: true });
    return true;
  } catch {
    return false;
  }
})();

export const HAS_SHARED_WASM_MEMORY = hasSharedWasmMemory;

const roundupWasmPages = (byteLength: number) =>
  Math.ceil(Math.max(0, byteLength) / WASM_MEMORY_PAGE_BYTES);

const createSharedWasmBuffer = (
  byteLength: number,
  maxByteLength: number,
) => {
  const memory = new WebAssembly.Memory({
    initial: roundupWasmPages(byteLength),
    maximum: Math.max(roundupWasmPages(byteLength), roundupWasmPages(maxByteLength)),
    shared: true,
  });
  const buffer = memory.buffer as SharedArrayBuffer;
  wasmSharedBufferMemory.set(buffer, memory);
  wasmSharedBufferMaxByteLength.set(buffer, maxByteLength);
  return buffer;
};

export const createWasmSharedArrayBuffer = (
  byteLength: number,
  maxByteLength = byteLength,
) => {
  if (hasSharedWasmMemory) {
    return createSharedWasmBuffer(byteLength, maxByteLength);
  }
  return new SharedArrayBuffer(byteLength);
};

const HAS_NATIVE_SAB_GROW =
  typeof SharedArrayBuffer === "function" &&
  typeof (SharedArrayBuffer.prototype as { grow?: unknown }).grow === "function";

export const HAS_SAB_GROW = HAS_NATIVE_SAB_GROW || hasSharedWasmMemory;

export const createSharedArrayBuffer = (
  byteLength: number,
  maxByteLength?: number,
) => {
  if (HAS_NATIVE_SAB_GROW && typeof maxByteLength === "number") {
    return new SharedArrayBuffer(byteLength, { maxByteLength });
  }
  if (hasSharedWasmMemory && typeof maxByteLength === "number") {
    return createSharedWasmBuffer(byteLength, maxByteLength);
  }
  return new SharedArrayBuffer(byteLength);
};

export const isWasmSharedArrayBuffer = (sab: SharedArrayBuffer) =>
  wasmSharedBufferMemory.has(sab);

export const isGrowableSharedArrayBuffer = (sab: SharedArrayBuffer) => {
  const value = sab as SharedArrayBufferWithGrow;
  return (HAS_NATIVE_SAB_GROW &&
      typeof value.grow === "function" &&
      value.growable === true) ||
    wasmSharedBufferMemory.has(sab);
};

export const sharedArrayBufferMaxByteLength = (
  sab: SharedArrayBuffer,
): number => {
  const value = sab as SharedArrayBufferWithGrow;
  if (typeof value.maxByteLength === "number") {
    return value.maxByteLength;
  }
  return wasmSharedBufferMaxByteLength.get(sab) ?? sab.byteLength;
};

export const growSharedArrayBuffer = (
  sab: SharedArrayBuffer,
  byteLength: number,
): SharedArrayBuffer => {
  const native = sab as SharedArrayBufferWithGrow;
  if (typeof native.grow === "function") {
    native.grow(byteLength);
    return sab;
  }

  const memory = wasmSharedBufferMemory.get(sab);
  if (memory == null) {
    throw new TypeError("SharedArrayBuffer is not growable");
  }

  const currentBuffer = memory.buffer as SharedArrayBuffer;
  if (currentBuffer.byteLength >= byteLength) {
    return currentBuffer;
  }

  const targetPages = roundupWasmPages(byteLength);
  const currentPages = roundupWasmPages(currentBuffer.byteLength);
  memory.grow(targetPages - currentPages);

  const nextBuffer = memory.buffer as SharedArrayBuffer;
  const maxByteLength =
    wasmSharedBufferMaxByteLength.get(sab) ?? currentBuffer.byteLength;
  wasmSharedBufferMemory.set(nextBuffer, memory);
  wasmSharedBufferMaxByteLength.set(nextBuffer, maxByteLength);
  return nextBuffer;
};
