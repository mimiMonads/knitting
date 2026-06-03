import { RUNTIME } from "../common/runtime.ts";
import { getNodeProcess } from "../common/node-compat.ts";
import { loadNodeBufferPointerAddon } from "./node-buffer-pointer.ts";

export type BufferReferenceRuntime = "node" | "deno" | "bun";

export const BUFFER_REFERENCE_KIND = "knitting.bufferReference" as const;

const EXTERNAL_PAYLOAD_BRAND = Symbol.for("knitting.payloadCodec");
export const BUFFER_REFERENCE_CODEC_ID = BUFFER_REFERENCE_KIND;

export type BufferReferenceMetadata = {
  readonly kind: typeof BUFFER_REFERENCE_KIND;
  readonly origin: string;
  readonly runtime: BufferReferenceRuntime;
  readonly pointer: string;
  readonly byteLength: number;
};

type BufferSource = ArrayBufferView | ArrayBuffer;

type NodeNativeRetainedPointer = {
  pointer: bigint;
  byteLength: number;
  token: bigint;
  release: (token: bigint) => boolean;
};

type NodeFinalizerHeldValue = {
  token: bigint;
  release: (token: bigint) => boolean;
};

type DenoUnsafePointer = {
  of: (value: ArrayBufferView | ArrayBuffer) => unknown;
  value: (pointer: unknown) => bigint;
  create: (value: bigint) => unknown;
};

type DenoUnsafePointerViewCtor = new (pointer: unknown) => {
  getArrayBuffer: (byteLength: number, byteOffset?: number) => ArrayBuffer;
};

type DenoLike = {
  pid?: number;
  UnsafePointer: DenoUnsafePointer;
  UnsafePointerView: DenoUnsafePointerViewCtor;
};

type BunFFILike = {
  ptr: (view: ArrayBufferView) => number;
  toArrayBuffer: (
    pointer: number,
    byteOffset: number,
    byteLength: number,
  ) => ArrayBuffer;
};

const getRuntime = (): BufferReferenceRuntime => {
  if (RUNTIME === "deno" || RUNTIME === "bun" || RUNTIME === "node") {
    return RUNTIME;
  }
  throw new Error(`BufferReference cannot run in runtime "${RUNTIME}"`);
};

const getDeno = (): DenoLike => {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno;
  if (deno?.UnsafePointer === undefined || deno.UnsafePointerView === undefined) {
    throw new Error("Deno FFI (UnsafePointer) is not available in this runtime");
  }
  return deno;
};

const getBunFFI = (): BunFFILike => {
  const ffi = (globalThis as typeof globalThis & {
    Bun?: { FFI?: Partial<BunFFILike> };
  }).Bun?.FFI;
  if (typeof ffi?.ptr !== "function" || typeof ffi?.toArrayBuffer !== "function") {
    throw new Error("Bun FFI (ptr/toArrayBuffer) is not available in this runtime");
  }
  return ffi as BunFFILike;
};

const getProcessId = (): number => {
  const proc = getNodeProcess() as { pid?: number } | undefined;
  if (proc !== undefined && typeof proc.pid === "number") return proc.pid;
  const deno = (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno;
  if (typeof deno?.pid === "number") return deno.pid;
  return 0;
};

const PROCESS_ORIGIN = `${RUNTIME}:${getProcessId()}`;

const PAYLOAD_TRANSPORT_FINALIZER = Symbol.for(
  "knitting.payloadCodec.transportFinalizer",
);
const MATERIALIZED_BUFFER_OWNER = Symbol.for(
  "knitting.bufferReference.materializedOwner",
);

const nodeNativeFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry<NodeFinalizerHeldValue>(({ token, release }) => {
    try {
      release(token);
    } catch {
    }
  })
  : undefined;

const isSharedArrayBufferInstance = (
  value: unknown,
): value is SharedArrayBuffer =>
  typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;

const asView = (source: BufferSource): ArrayBufferView => {
  if (isSharedArrayBufferInstance(source)) {
    throw new TypeError(
      "BufferReference expects ArrayBuffer memory; SharedArrayBuffer is already shared and cannot be detached",
    );
  }
  if (ArrayBuffer.isView(source)) return source;
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  throw new TypeError(
    "BufferReference expects an ArrayBuffer or typed-array view",
  );
};

const assertArrayBufferBackedView = (view: ArrayBufferView): void => {
  if (isSharedArrayBufferInstance(view.buffer)) {
    throw new TypeError(
      "BufferReference expects ArrayBuffer-backed views; SharedArrayBuffer is already shared and cannot be detached",
    );
  }
};

const extractPointer = (
  runtime: BufferReferenceRuntime,
  view: ArrayBufferView,
): bigint => {
  switch (runtime) {
    case "deno": {
      const deno = getDeno();
      const pointer = deno.UnsafePointer.of(view);
      if (pointer === null || pointer === undefined) {
        throw new Error("Deno.UnsafePointer.of returned null");
      }
      return deno.UnsafePointer.value(pointer);
    }
    case "bun": {
      const pointer = getBunFFI().ptr(view);
      if (!pointer) throw new Error("Bun.FFI.ptr returned a null pointer");
      return BigInt(pointer);
    }
    case "node": {
      const pointer = loadNodeBufferPointerAddon().getPointer(view);
      if (!pointer) throw new Error("knitting_buffer_pointer returned null");
      return pointer;
    }
  }
};

const retainNodePointer = (
  view: ArrayBufferView,
): NodeNativeRetainedPointer => {
  const addon = loadNodeBufferPointerAddon();
  const retained = addon.retainPointer(view);
  return {
    pointer: retained.pointer,
    byteLength: retained.byteLength,
    token: retained.token,
    release: addon.releasePointer,
  };
};

const materialize = (
  runtime: BufferReferenceRuntime,
  pointer: bigint,
  byteLength: number,
): ArrayBuffer => {
  switch (runtime) {
    case "deno": {
      const deno = getDeno();
      const handle = deno.UnsafePointer.create(pointer);
      if (handle === null || handle === undefined) {
        throw new Error("Deno.UnsafePointer.create returned null");
      }
      return new deno.UnsafePointerView(handle).getArrayBuffer(byteLength);
    }
    case "bun":
      return getBunFFI().toArrayBuffer(Number(pointer), 0, byteLength);
    case "node":
      return loadNodeBufferPointerAddon().wrapPointer(pointer, byteLength);
  }
};

const holdMaterializedOwner = (
  buffer: ArrayBuffer,
  owner: BufferReference,
): ArrayBuffer => {
  try {
    Object.defineProperty(buffer, MATERIALIZED_BUFFER_OWNER, { value: owner });
  } catch {
  }
  return buffer;
};

type TransferableArrayBuffer = ArrayBuffer & {
  readonly detached?: boolean;
  transfer?: (newByteLength?: number) => ArrayBuffer;
  transferToFixedLength?: (newByteLength?: number) => ArrayBuffer;
};

const isDetached = (buffer: ArrayBuffer): boolean =>
  (buffer as TransferableArrayBuffer).detached === true ||
  buffer.byteLength === 0;

const detachArrayBufferBestEffort = (
  runtime: BufferReferenceRuntime,
  buffer: ArrayBuffer,
): boolean => {
  if (isDetached(buffer)) return true;

  if (runtime === "node") {
    try {
      return loadNodeBufferPointerAddon().detachArrayBuffer(buffer);
    } catch {
    }
  }

  const transferable = buffer as TransferableArrayBuffer;
  try {
    if (typeof transferable.transferToFixedLength === "function") {
      transferable.transferToFixedLength(0);
      return isDetached(buffer);
    }
    if (typeof transferable.transfer === "function") {
      transferable.transfer(0);
      return isDetached(buffer);
    }
  } catch {
  }

  try {
    if (typeof structuredClone === "function") {
      structuredClone(buffer, { transfer: [buffer] });
      return isDetached(buffer);
    }
  } catch {
  }

  return false;
};

export const isBufferReferenceMetadata = (
  value: unknown,
): value is BufferReferenceMetadata => {
  if (value === null || typeof value !== "object") return false;
  const meta = value as Partial<BufferReferenceMetadata>;
  return (
    meta.kind === BUFFER_REFERENCE_KIND &&
    typeof meta.origin === "string" &&
    (meta.runtime === "node" || meta.runtime === "deno" || meta.runtime === "bun") &&
    typeof meta.pointer === "string" &&
    typeof meta.byteLength === "number" &&
    Number.isInteger(meta.byteLength) &&
    meta.byteLength >= 0
  );
};

export class BufferReference {
  readonly [EXTERNAL_PAYLOAD_BRAND] = BUFFER_REFERENCE_CODEC_ID;
  readonly runtime: BufferReferenceRuntime;
  readonly origin: string;
  readonly pointer: bigint;
  readonly byteLength: number;

  #source: BufferSource | undefined;
  #native: NodeNativeRetainedPointer | undefined;
  #finalizerToken: object | undefined;
  #materializedBuffers: ArrayBuffer[] | undefined;
  #transportRefs = 0;
  #released = false;

  constructor(source: BufferSource);
  constructor(source: BufferSource | undefined, meta: BufferReferenceMetadata);
  constructor(source: BufferSource | undefined, meta?: BufferReferenceMetadata) {
    if (meta !== undefined) {
      this.runtime = meta.runtime;
      this.origin = meta.origin;
      this.pointer = BigInt(meta.pointer);
      this.byteLength = meta.byteLength;
      this.#source = source;
      return;
    }

    if (source === undefined) {
      throw new TypeError("BufferReference requires a buffer source");
    }

    const view = asView(source);
    assertArrayBufferBackedView(view);
    this.runtime = getRuntime();
    this.origin = PROCESS_ORIGIN;
    if (this.runtime === "node") {
      this.#native = retainNodePointer(view);
      this.pointer = this.#native.pointer;
      this.byteLength = this.#native.byteLength;
      this.#finalizerToken = {};
      nodeNativeFinalizer?.register(
        this,
        {
          token: this.#native.token,
          release: this.#native.release,
        },
        this.#finalizerToken,
      );
      return;
    }

    this.pointer = extractPointer(this.runtime, view);
    this.byteLength = view.byteLength;
    this.#source = source;
  }

  static fromMetadata(meta: BufferReferenceMetadata): BufferReference {
    if (!isBufferReferenceMetadata(meta)) {
      throw new TypeError("Invalid BufferReferenceMetadata");
    }
    return new BufferReference(undefined, meta);
  }

  toMetadata(): BufferReferenceMetadata {
    this.#assertActive();
    return {
      kind: BUFFER_REFERENCE_KIND,
      origin: this.origin,
      runtime: this.runtime,
      pointer: this.pointer.toString(),
      byteLength: this.byteLength,
    };
  }

  get isLocal(): boolean {
    return this.origin === PROCESS_ORIGIN && this.runtime === RUNTIME;
  }

  #assertLocal(): void {
    if (this.origin !== PROCESS_ORIGIN) {
      throw new Error(
        `BufferReference cannot cross a process boundary (origin ${this.origin} ` +
          `!= ${PROCESS_ORIGIN}). Use ProcessSharedBuffer for cross-process memory.`,
      );
    }
    if (this.runtime !== RUNTIME) {
      throw new Error(
        `BufferReference runtime mismatch: produced on ${this.runtime}, ` +
          `materializing on ${RUNTIME}.`,
      );
    }
  }

  #assertActive(): void {
    if (this.#released) {
      throw new Error("BufferReference has been released");
    }
  }

  toArrayBuffer(): ArrayBuffer {
    this.#assertActive();
    this.#assertLocal();
    const buffer = holdMaterializedOwner(
      materialize(this.runtime, this.pointer, this.byteLength),
      this,
    );
    (this.#materializedBuffers ??= []).push(buffer);
    return buffer;
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.toArrayBuffer());
  }

  get source(): BufferSource | undefined {
    return this.#source;
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    const materializedBuffers = this.#materializedBuffers;
    this.#materializedBuffers = undefined;
    if (materializedBuffers !== undefined) {
      for (let i = 0; i < materializedBuffers.length; i++) {
        detachArrayBufferBestEffort(this.runtime, materializedBuffers[i]!);
      }
    }
    if (this.#finalizerToken !== undefined) {
      nodeNativeFinalizer?.unregister(this.#finalizerToken);
      this.#finalizerToken = undefined;
    }
    if (this.#native !== undefined) {
      try {
        this.#native.release(this.#native.token);
      } catch {
      }
      this.#native = undefined;
    }
    this.#source = undefined;
  }

  [PAYLOAD_TRANSPORT_FINALIZER](): (() => void) | undefined {
    if (this.#released) return undefined;
    this.#transportRefs++;
    let finalized = false;
    return () => {
      if (finalized) return;
      finalized = true;
      this.#transportRefs--;
      if (this.#transportRefs <= 0) this.#release();
    };
  }
}

const codecGlobal = globalThis as typeof globalThis & {
  __KNITTING_PAYLOAD_CODECS__?: Record<
    string,
    {
      decode: (metadata: unknown) => unknown;
      decodeNumeric?: (metadata: ArrayLike<number>) => unknown;
    } | undefined
  >;
};

const codecs = codecGlobal.__KNITTING_PAYLOAD_CODECS__ ??= Object.create(
  null,
) as NonNullable<typeof codecGlobal.__KNITTING_PAYLOAD_CODECS__>;

codecs[BUFFER_REFERENCE_CODEC_ID] = {
  decode: (metadata) =>
    BufferReference.fromMetadata(metadata as BufferReferenceMetadata),
};
