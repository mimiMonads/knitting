import { resolveKnittingPackageAsset } from "./package-assets.ts";
import { requireDetachedExternalArrayBuffer } from "./external-array-buffer.ts";
import {
  getNodeFfi,
  type NodeFfiFunctionSignature,
  type NodeFfiLibrary,
} from "./node-ffi-api.ts";
import {
  type CreateSharedMemoryOptions,
  expectFd,
  expectPositiveSize,
  type MapSharedMemoryOptions,
  readCreateMode,
  readCreateSize,
  readRequiredCreateName,
  type SharedMemoryConnectionPrimitives,
  type SharedMemoryMapping,
} from "./types.ts";

const WINDOWS_CREATE_MODE_CREATE = 1;
const WINDOWS_CREATE_MODE_OPEN = 2;
const WINDOWS_MAPPING_RECORD_BYTES = 32;
const POINTER_OFFSET = 0;
const HANDLE_OFFSET = 8;
const SIZE_OFFSET = 16;
const BASE_ADDRESS_MOD_64_OFFSET = 24;
const WINDOWS_CREATE_SHARED_MEMORY = "knitting_windows_create_shared_memory";
const WINDOWS_MAP_SHARED_MEMORY = "knitting_windows_map_shared_memory";
const WINDOWS_CLOSE_SHARED_MEMORY = "knitting_windows_close_shared_memory";

type WindowsNativeMapping = {
  address: bigint;
  handle: bigint;
  size: number;
  baseAddressMod64: number;
};

type WindowsSharedMemorySymbols = {
  [WINDOWS_CREATE_SHARED_MEMORY]: (
    size: bigint,
    name: Uint16Array,
    mode: number,
    out: Uint8Array,
  ) => number;
  [WINDOWS_MAP_SHARED_MEMORY]: (
    handle: bigint,
    size: bigint,
    name: Uint16Array,
    out: Uint8Array,
  ) => number;
  [WINDOWS_CLOSE_SHARED_MEMORY]: (mapping: Uint8Array) => number;
};

type WindowsCreateSharedMemory =
  WindowsSharedMemorySymbols[typeof WINDOWS_CREATE_SHARED_MEMORY];
type WindowsMapSharedMemory =
  WindowsSharedMemorySymbols[typeof WINDOWS_MAP_SHARED_MEMORY];
type WindowsRecordReader<Library> = (
  record: Uint8Array,
  name: string | undefined,
  lib: Library,
) => SharedMemoryMapping<ArrayBuffer>;

type DenoWindowsLibrary = {
  symbols: WindowsSharedMemorySymbols;
  close: () => void;
};

type DenoLike = {
  build?: { arch?: string; os?: string };
  dlopen: (
    path: string,
    symbols: Record<string, unknown>,
  ) => DenoWindowsLibrary;
  UnsafePointer?: {
    create: (value: bigint) => unknown;
  };
  UnsafePointerView: new (pointer: object) => {
    getArrayBuffer: (byteLength: number) => ArrayBuffer;
  };
};

type BunPointer = number;

type BunFFIApi = {
  dlopen: (
    path: string,
    symbols: Record<string, unknown>,
  ) => unknown;
  toArrayBuffer: (
    pointer: BunPointer,
    byteOffset: number,
    byteLength: number,
  ) => ArrayBuffer;
};

type BunWindowsLibrary = {
  symbols: WindowsSharedMemorySymbols;
};

type NodeWindowsLibrary = {
  functions: WindowsSharedMemorySymbols;
  lib: NodeFfiLibrary;
};

const FFIType = {
  i32: 5,
  u32: 6,
  i64: 7,
  ptr: 12,
} as const;

let anonymousNameCounter = 0;

const getDeno = (): DenoLike => {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno;
  if (deno === undefined) {
    throw new Error(
      "Deno Windows shared memory primitives can only run in Deno",
    );
  }

  return deno;
};

const getBunFFI = (): BunFFIApi => {
  const ffi = (globalThis as typeof globalThis & {
    Bun?: { FFI?: Partial<BunFFIApi> };
  }).Bun?.FFI;

  if (
    typeof ffi?.dlopen !== "function" ||
    typeof ffi?.toArrayBuffer !== "function"
  ) {
    throw new Error("Bun FFI is not available in this runtime");
  }

  return ffi as BunFFIApi;
};

export const isWindowsRuntime = (): boolean => {
  const denoOs = (globalThis as typeof globalThis & {
    Deno?: { build?: { os?: string } };
  }).Deno?.build?.os;
  if (denoOs !== undefined) return denoOs === "windows";

  const processPlatform = (globalThis as typeof globalThis & {
    process?: { platform?: string };
  }).process?.platform;
  return processPlatform === "win32";
};

const windowsArch = (): string => {
  const denoArch = (globalThis as typeof globalThis & {
    Deno?: { build?: { arch?: string } };
  }).Deno?.build?.arch;
  if (denoArch === "x86_64") return "x64";

  const processArch = (globalThis as typeof globalThis & {
    process?: { arch?: string };
  }).process?.arch;
  if (processArch === "x64") return processArch;

  throw new Error("Windows shared memory prebuilds support x64 only");
};

export const windowsSharedMemoryPrebuildPath = (): string =>
  resolveKnittingPackageAsset(
    "prebuilds",
    `win32-${windowsArch()}`,
    "knitting_windows_shared_memory.dll",
  );

export const makeWindowsAnonymousSharedMemoryName = (
  runtime: string,
): string => {
  const processId = (globalThis as typeof globalThis & {
    process?: { pid?: number };
    Deno?: { pid?: number };
  }).process?.pid ??
    (globalThis as typeof globalThis & { Deno?: { pid?: number } }).Deno?.pid ??
    0;
  const next = anonymousNameCounter++;
  const timeTag = Date.now().toString(36);
  const randomTag = Math.random().toString(36).slice(2, 10);
  const runtimeTag = runtime.replace(/[^a-z0-9_-]/gi, "").slice(0, 12) || "js";

  return `Local\\knit_${runtimeTag}_${processId}_${timeTag}_${next}_${randomTag}`;
};

const readWindowsCreate = (
  options: number | CreateSharedMemoryOptions,
  runtime: string,
): { mode: number; name: string } => {
  const mode = readCreateMode(options);
  if (mode === "anonymous") {
    return {
      mode: WINDOWS_CREATE_MODE_CREATE,
      name: makeWindowsAnonymousSharedMemoryName(runtime),
    };
  }

  return {
    mode: mode === "open"
      ? WINDOWS_CREATE_MODE_OPEN
      : WINDOWS_CREATE_MODE_CREATE,
    name: readRequiredCreateName(options),
  };
};

const encodeWideCString = (value: string | undefined): Uint16Array => {
  const out = new Uint16Array((value?.length ?? 0) + 1);
  if (value === undefined) return out;

  for (let index = 0; index < value.length; index += 1) {
    out[index] = value.charCodeAt(index);
  }
  return out;
};

const readWindowsNativeMapping = (record: Uint8Array): WindowsNativeMapping => {
  const view = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  );
  const address = view.getBigUint64(POINTER_OFFSET, true);
  const handle = view.getBigUint64(HANDLE_OFFSET, true);
  const size = view.getBigUint64(SIZE_OFFSET, true);
  if (address === 0n || handle === 0n) {
    throw new Error("Windows shared memory backend returned an empty mapping");
  }
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Windows shared memory mapping is too large");
  }

  return {
    address,
    handle,
    size: Number(size),
    baseAddressMod64: view.getUint32(BASE_ADDRESS_MOD_64_OFFSET, true),
  };
};

const fdFromHandle = (handle: bigint): number =>
  handle <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(handle) : 0;

const checkWindowsResult = (result: number, message: string): void => {
  if (result !== 0) {
    throw new Error(`${message} failed with Windows error ${result}`);
  }
};

const createRecord = (): Uint8Array =>
  new Uint8Array(
    WINDOWS_MAPPING_RECORD_BYTES,
  );

const DENO_WINDOWS_SYMBOLS = {
  [WINDOWS_CREATE_SHARED_MEMORY]: {
    parameters: ["u64", "buffer", "u32", "buffer"],
    result: "i32",
  },
  [WINDOWS_MAP_SHARED_MEMORY]: {
    parameters: ["u64", "u64", "buffer", "buffer"],
    result: "i32",
  },
  [WINDOWS_CLOSE_SHARED_MEMORY]: {
    parameters: ["buffer"],
    result: "i32",
  },
} as const;

const BUN_WINDOWS_SYMBOLS = {
  [WINDOWS_CREATE_SHARED_MEMORY]: {
    args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  [WINDOWS_MAP_SHARED_MEMORY]: {
    args: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  [WINDOWS_CLOSE_SHARED_MEMORY]: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;

const NODE_WINDOWS_SYMBOLS = {
  [WINDOWS_CREATE_SHARED_MEMORY]: {
    arguments: ["u64", "pointer", "u32", "pointer"],
    return: "i32",
  },
  [WINDOWS_MAP_SHARED_MEMORY]: {
    arguments: ["u64", "u64", "pointer", "pointer"],
    return: "i32",
  },
  [WINDOWS_CLOSE_SHARED_MEMORY]: {
    arguments: ["pointer"],
    return: "i32",
  },
} satisfies Record<keyof WindowsSharedMemorySymbols, NodeFfiFunctionSignature>;

export const openDenoWindowsSharedMemoryLibrary = (): DenoWindowsLibrary =>
  getDeno().dlopen(windowsSharedMemoryPrebuildPath(), DENO_WINDOWS_SYMBOLS);

export const openBunWindowsSharedMemoryLibrary = (): BunWindowsLibrary =>
  getBunFFI().dlopen(
    windowsSharedMemoryPrebuildPath(),
    BUN_WINDOWS_SYMBOLS,
  ) as BunWindowsLibrary;

let cachedNodeWindowsLibrary: NodeWindowsLibrary | undefined;

export const openNodeWindowsSharedMemoryLibrary = (): NodeWindowsLibrary => {
  if (cachedNodeWindowsLibrary !== undefined) {
    return cachedNodeWindowsLibrary;
  }
  const opened = getNodeFfi().dlopen(
    windowsSharedMemoryPrebuildPath(),
    NODE_WINDOWS_SYMBOLS,
  ) as unknown as NodeWindowsLibrary;
  cachedNodeWindowsLibrary = opened;
  return opened;
};

const closeWindowsMapping = (
  record: Uint8Array,
  closeSharedMemory: (record: Uint8Array) => number,
): () => void => {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    checkWindowsResult(
      closeSharedMemory(record),
      "knitting_windows_close_shared_memory",
    );
  };
};

const makeWindowsMapping = (
  runtime: "deno" | "bun" | "node",
  mapping: WindowsNativeMapping,
  name: string | undefined,
  arrayBuffer: ArrayBuffer,
  unsafePointer: unknown,
  close: () => void,
): SharedMemoryMapping<ArrayBuffer> => ({
  runtime,
  fd: fdFromHandle(mapping.handle),
  name,
  size: mapping.size,
  byteLength: arrayBuffer.byteLength,
  buffer: arrayBuffer,
  kind: "external-array-buffer",
  arrayBuffer,
  unsafePointer,
  baseAddressMod64: mapping.baseAddressMod64,
  close,
});

const fromDenoWindowsRecord = (
  record: Uint8Array,
  name: string | undefined,
  lib: DenoWindowsLibrary,
): SharedMemoryMapping<ArrayBuffer> => {
  const mapping = readWindowsNativeMapping(record);
  const pointer = getDeno().UnsafePointer?.create(mapping.address);
  if (
    pointer === undefined || pointer === null || typeof pointer !== "object"
  ) {
    throw new Error("Deno UnsafePointer.create is not available");
  }

  const arrayBuffer = new (getDeno().UnsafePointerView)(pointer)
    .getArrayBuffer(mapping.size);

  return makeWindowsMapping(
    "deno",
    mapping,
    name,
    arrayBuffer,
    pointer,
    closeWindowsMapping(
      record,
      lib.symbols[WINDOWS_CLOSE_SHARED_MEMORY],
    ),
  );
};

const fromBunWindowsRecord = (
  record: Uint8Array,
  name: string | undefined,
  lib: BunWindowsLibrary,
): SharedMemoryMapping<ArrayBuffer> => {
  const mapping = readWindowsNativeMapping(record);
  if (mapping.address > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Windows mapping pointer is too large for Bun FFI");
  }

  const arrayBuffer = getBunFFI().toArrayBuffer(
    Number(mapping.address),
    0,
    mapping.size,
  );

  return makeWindowsMapping(
    "bun",
    mapping,
    name,
    arrayBuffer,
    Number(mapping.address),
    closeWindowsMapping(
      record,
      lib.symbols[WINDOWS_CLOSE_SHARED_MEMORY],
    ),
  );
};

const fromNodeWindowsRecord = (
  record: Uint8Array,
  name: string | undefined,
  lib: NodeWindowsLibrary,
): SharedMemoryMapping<ArrayBuffer> => {
  const mapping = readWindowsNativeMapping(record);
  const arrayBuffer = getNodeFfi().toArrayBuffer(
    mapping.address,
    mapping.size,
    false,
  );
  let closed = false;

  return makeWindowsMapping(
    "node",
    mapping,
    name,
    arrayBuffer,
    mapping.address,
    () => {
      if (closed) return;
      requireDetachedExternalArrayBuffer(arrayBuffer);
      checkWindowsResult(
        lib.functions[WINDOWS_CLOSE_SHARED_MEMORY](record),
        WINDOWS_CLOSE_SHARED_MEMORY,
      );
      closed = true;
    },
  );
};

const createWindowsSharedMemory = <Library>(
  options: number | CreateSharedMemoryOptions,
  runtime: "deno" | "bun" | "node",
  lib: Library,
  createSharedMemory: WindowsCreateSharedMemory,
  fromRecord: WindowsRecordReader<Library>,
): SharedMemoryMapping<ArrayBuffer> => {
  const size = expectPositiveSize(readCreateSize(options));
  const { mode, name } = readWindowsCreate(options, runtime);
  const record = createRecord();
  checkWindowsResult(
    createSharedMemory(
      BigInt(size),
      encodeWideCString(name),
      mode,
      record,
    ),
    WINDOWS_CREATE_SHARED_MEMORY,
  );

  return fromRecord(record, name, lib);
};

const mapWindowsSharedMemory = <Library>(
  options: MapSharedMemoryOptions,
  lib: Library,
  mapSharedMemory: WindowsMapSharedMemory,
  fromRecord: WindowsRecordReader<Library>,
): SharedMemoryMapping<ArrayBuffer> => {
  const fd = expectFd(options.fd);
  const size = expectPositiveSize(options.size);
  const record = createRecord();
  checkWindowsResult(
    mapSharedMemory(
      BigInt(fd),
      BigInt(size),
      encodeWideCString(options.name),
      record,
    ),
    WINDOWS_MAP_SHARED_MEMORY,
  );

  return fromRecord(record, options.name, lib);
};

export const createDenoWindowsSharedMemory = (
  options: number | CreateSharedMemoryOptions,
  lib = openDenoWindowsSharedMemoryLibrary(),
): SharedMemoryMapping<ArrayBuffer> =>
  createWindowsSharedMemory(
    options,
    "deno",
    lib,
    lib.symbols[WINDOWS_CREATE_SHARED_MEMORY],
    fromDenoWindowsRecord,
  );

export const mapDenoWindowsSharedMemory = (
  options: MapSharedMemoryOptions,
  lib = openDenoWindowsSharedMemoryLibrary(),
): SharedMemoryMapping<ArrayBuffer> =>
  mapWindowsSharedMemory(
    options,
    lib,
    lib.symbols[WINDOWS_MAP_SHARED_MEMORY],
    fromDenoWindowsRecord,
  );

const createWindowsConnectionPrimitives = <Library>(
  runtime: "deno" | "bun" | "node",
  lib: Library,
  createSharedMemory: (
    options: number | CreateSharedMemoryOptions,
    lib: Library,
  ) => SharedMemoryMapping<ArrayBuffer>,
  mapSharedMemory: (
    options: MapSharedMemoryOptions,
    lib: Library,
  ) => SharedMemoryMapping<ArrayBuffer>,
): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> => ({
  runtime,
  createSharedMemory: (options) => createSharedMemory(options, lib),
  mapSharedMemory: (options) => mapSharedMemory(options, lib),
});

export const createDenoWindowsConnectionPrimitives = (
  lib = openDenoWindowsSharedMemoryLibrary(),
): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> =>
  createWindowsConnectionPrimitives(
    "deno",
    lib,
    createDenoWindowsSharedMemory,
    mapDenoWindowsSharedMemory,
  );

export const createBunWindowsSharedMemory = (
  options: number | CreateSharedMemoryOptions,
  lib = openBunWindowsSharedMemoryLibrary(),
): SharedMemoryMapping<ArrayBuffer> =>
  createWindowsSharedMemory(
    options,
    "bun",
    lib,
    lib.symbols[WINDOWS_CREATE_SHARED_MEMORY],
    fromBunWindowsRecord,
  );

export const mapBunWindowsSharedMemory = (
  options: MapSharedMemoryOptions,
  lib = openBunWindowsSharedMemoryLibrary(),
): SharedMemoryMapping<ArrayBuffer> =>
  mapWindowsSharedMemory(
    options,
    lib,
    lib.symbols[WINDOWS_MAP_SHARED_MEMORY],
    fromBunWindowsRecord,
  );

export const createBunWindowsConnectionPrimitives = (
  lib = openBunWindowsSharedMemoryLibrary(),
): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> =>
  createWindowsConnectionPrimitives(
    "bun",
    lib,
    createBunWindowsSharedMemory,
    mapBunWindowsSharedMemory,
  );

export const createNodeWindowsSharedMemory = (
  options: number | CreateSharedMemoryOptions,
  lib = openNodeWindowsSharedMemoryLibrary(),
): SharedMemoryMapping<ArrayBuffer> =>
  createWindowsSharedMemory(
    options,
    "node",
    lib,
    lib.functions[WINDOWS_CREATE_SHARED_MEMORY],
    fromNodeWindowsRecord,
  );

export const mapNodeWindowsSharedMemory = (
  options: MapSharedMemoryOptions,
  lib = openNodeWindowsSharedMemoryLibrary(),
): SharedMemoryMapping<ArrayBuffer> =>
  mapWindowsSharedMemory(
    options,
    lib,
    lib.functions[WINDOWS_MAP_SHARED_MEMORY],
    fromNodeWindowsRecord,
  );

export const createNodeWindowsConnectionPrimitives = (
  lib = openNodeWindowsSharedMemoryLibrary(),
): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> =>
  createWindowsConnectionPrimitives(
    "node",
    lib,
    createNodeWindowsSharedMemory,
    mapNodeWindowsSharedMemory,
  );
