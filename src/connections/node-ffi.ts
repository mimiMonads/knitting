import {
  checkPosixResult,
  DARWIN_O_CREAT,
  DARWIN_O_EXCL,
  DARWIN_SHM_MODE,
  detectPosixPlatform,
  encodeCString,
  type ErrnoReader,
  getErrnoSymbolName,
  getPosixLibcPath,
  LINUX_O_CREAT,
  LINUX_O_EXCL,
  makeDarwinSharedMemoryName,
  makeErrnoReader,
  MAP_SHARED,
  O_RDWR,
  POSIX_SHM_MODE,
  posixError,
  type PosixPlatform,
  PROT_READ,
  PROT_WRITE,
  setCloseOnExec,
  toPosixSharedMemoryName,
} from "./posix.ts";
import {
  createNodeWindowsConnectionPrimitives,
  isWindowsRuntime,
} from "./windows.ts";
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
  readCreateName,
  readCreateSize,
  readRequiredCreateName,
  type SharedMemoryConnectionPrimitives,
  type SharedMemoryMapping,
} from "./types.ts";

export { getNodeFfi, isNodeFfiTarget } from "./node-ffi-api.ts";
export type {
  NodeFfiApi,
  NodeFfiDlopenResult,
  NodeFfiFunctionSignature,
  NodeFfiLibrary,
} from "./node-ffi-api.ts";

type NodePosixFunctions = {
  memfd_create?: (name: Uint8Array, flags: number) => number;
  shm_open?: (name: Uint8Array, flags: number, mode: number) => number;
  shm_unlink?: (name: Uint8Array) => number;
  __error?: () => bigint;
  __errno_location?: () => bigint;
  ftruncate: (fd: number, length: bigint) => number;
  dup: (fd: number) => number;
  fcntl: (fd: number, cmd: number, arg: number) => number;
  mmap: (
    address: null,
    length: bigint,
    protection: number,
    flags: number,
    fd: number,
    offset: bigint,
  ) => bigint;
  munmap: (address: bigint, length: bigint) => number;
  close: (fd: number) => number;
};

type NodePosixLibrary = {
  functions: NodePosixFunctions;
  lib: NodeFfiLibrary;
};

let cachedNodePosixLibrary: NodePosixLibrary | undefined;

const getNodeCreateSymbols = (
  platform = detectPosixPlatform(),
): Record<string, NodeFfiFunctionSignature> => {
  if (platform === "darwin") {
    return {
      shm_open: {
        arguments: ["pointer", "i32", "u32"],
        return: "i32",
      },
      shm_unlink: {
        arguments: ["pointer"],
        return: "i32",
      },
    };
  }

  return {
    memfd_create: {
      arguments: ["pointer", "u32"],
      return: "i32",
    },
    shm_open: {
      arguments: ["pointer", "i32", "u32"],
      return: "i32",
    },
    shm_unlink: {
      arguments: ["pointer"],
      return: "i32",
    },
  };
};

const getNodeErrnoSymbols = (
  platform = detectPosixPlatform(),
): Record<string, NodeFfiFunctionSignature> => ({
  [getErrnoSymbolName(platform)]: {
    arguments: [],
    return: "pointer",
  },
});

const getNodePosixSymbols = (): Record<string, NodeFfiFunctionSignature> => ({
  ...getNodeCreateSymbols(),
  ftruncate: {
    arguments: ["i32", "i64"],
    return: "i32",
  },
  dup: {
    arguments: ["i32"],
    return: "i32",
  },
  fcntl: {
    arguments: ["i32", "i32", "i32"],
    return: "i32",
  },
  mmap: {
    arguments: ["pointer", "u64", "i32", "i32", "i32", "i64"],
    return: "pointer",
  },
  munmap: {
    arguments: ["pointer", "u64"],
    return: "i32",
  },
  close: {
    arguments: ["i32"],
    return: "i32",
  },
});

export const openNodePosixLibrary = (): NodePosixLibrary => {
  if (cachedNodePosixLibrary !== undefined) return cachedNodePosixLibrary;

  const symbols = getNodePosixSymbols();
  const ffi = getNodeFfi();
  // errno is diagnostics only: if this libc or FFI build will not bind the
  // nullary errno accessor, open without it rather than lose shared memory.
  let opened: NodePosixLibrary;
  try {
    opened = ffi.dlopen<NodePosixFunctions>(getPosixLibcPath(), {
      ...symbols,
      ...getNodeErrnoSymbols(),
    });
  } catch {
    opened = ffi.dlopen<NodePosixFunctions>(getPosixLibcPath(), symbols);
  }
  cachedNodePosixLibrary = opened;
  return opened;
};

const errnoOf = (
  libc: NodePosixFunctions,
  platform = detectPosixPlatform(),
): ErrnoReader =>
  makeErrnoReader(
    platform === "darwin" ? libc.__error : libc.__errno_location,
    (pointer) =>
      new Int32Array(getNodeFfi().toArrayBuffer(pointer, 4, true))[0],
  );

const isMapFailed = (pointer: bigint): boolean =>
  pointer === 0n ||
  pointer === -1n ||
  pointer === BigInt.asUintN(64, -1n);

const createAnonymousFd = (
  name: string,
  platform: PosixPlatform,
  libc: NodePosixFunctions,
): number => {
  if (platform === "darwin") {
    const shmOpen = libc.shm_open;
    const shmUnlink = libc.shm_unlink;
    if (shmOpen === undefined || shmUnlink === undefined) {
      throw new Error("shm_open symbols are not available");
    }

    const shmName = encodeCString(makeDarwinSharedMemoryName(name, "node"));
    const fd = checkPosixResult(
      shmOpen(
        shmName,
        O_RDWR | DARWIN_O_CREAT | DARWIN_O_EXCL,
        DARWIN_SHM_MODE,
      ),
      "shm_open failed",
      errnoOf(libc, platform),
      platform,
    );
    shmUnlink(shmName);
    try {
      return setCloseOnExec({ symbols: libc }, fd);
    } catch (error) {
      libc.close(fd);
      throw error;
    }
  }

  const memfdCreate = libc.memfd_create;
  if (memfdCreate === undefined) {
    throw new Error("memfd_create symbol is not available");
  }
  const fd = checkPosixResult(
    memfdCreate(encodeCString(name), 0),
    "memfd_create failed",
    errnoOf(libc, platform),
    platform,
  );
  try {
    return setCloseOnExec({ symbols: libc }, fd);
  } catch (error) {
    libc.close(fd);
    throw error;
  }
};

const createNamedFd = (
  name: string,
  mode: "create" | "open",
  platform: PosixPlatform,
  libc: NodePosixFunctions,
): number => {
  const shmOpen = libc.shm_open;
  if (shmOpen === undefined) {
    throw new Error("shm_open symbol is not available");
  }

  const createFlag = platform === "darwin" ? DARWIN_O_CREAT : LINUX_O_CREAT;
  const exclusiveFlag = platform === "darwin" ? DARWIN_O_EXCL : LINUX_O_EXCL;
  const flags = mode === "create"
    ? O_RDWR | createFlag | exclusiveFlag
    : O_RDWR;
  const shmMode = platform === "darwin" ? DARWIN_SHM_MODE : POSIX_SHM_MODE;
  const fd = checkPosixResult(
    shmOpen(
      encodeCString(toPosixSharedMemoryName(name)),
      flags,
      shmMode,
    ),
    "shm_open failed",
    errnoOf(libc, platform),
    platform,
  );

  try {
    return setCloseOnExec({ symbols: libc }, fd);
  } catch (error) {
    libc.close(fd);
    throw error;
  }
};

const mapFd = (
  fd: number,
  size: number,
  name: string | undefined,
  libc: NodePosixFunctions,
  closeFdOnFailure: boolean,
): SharedMemoryMapping<ArrayBuffer> => {
  const pointer = libc.mmap(
    null,
    BigInt(size),
    PROT_READ | PROT_WRITE,
    MAP_SHARED,
    fd,
    0n,
  );
  if (isMapFailed(pointer)) {
    // errno first: fcntl below overwrites it.
    const error = posixError("mmap failed", errnoOf(libc));
    const descriptorFlags = libc.fcntl(fd, 1, 0);
    if (closeFdOnFailure) libc.close(fd);
    error.message +=
      ` (fd ${fd}, size ${size}, descriptor flags ${descriptorFlags})`;
    throw error;
  }

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = getNodeFfi().toArrayBuffer(pointer, size, false);
  } catch (error) {
    libc.munmap(pointer, BigInt(size));
    if (closeFdOnFailure) libc.close(fd);
    throw error;
  }
  let closed = false;
  return {
    runtime: "node",
    fd,
    name,
    size,
    byteLength: arrayBuffer.byteLength,
    buffer: arrayBuffer,
    kind: "external-array-buffer",
    arrayBuffer,
    unsafePointer: pointer,
    baseAddressMod64: Number(pointer % 64n),
    close: () => {
      if (closed) return;
      requireDetachedExternalArrayBuffer(arrayBuffer);
      closed = true;
      try {
        libc.munmap(pointer, BigInt(size));
      } finally {
        libc.close(fd);
      }
    },
  };
};

export const mapNodeFfiSharedMemory = (
  options: MapSharedMemoryOptions,
  library = openNodePosixLibrary(),
): SharedMemoryMapping<ArrayBuffer> => {
  const libc = library.functions;
  const size = expectPositiveSize(options.size);
  let fd: number;
  let closeFdOnFailure = true;
  if (options.name !== undefined) {
    fd = createNamedFd(
      options.name,
      "open",
      detectPosixPlatform(),
      libc,
    );
  } else {
    const sourceFd = expectFd(options.fd);
    closeFdOnFailure = options.duplicateFd !== false;
    fd = closeFdOnFailure
      ? checkPosixResult(libc.dup(sourceFd), "dup(fd) failed", errnoOf(libc))
      : sourceFd;
    if (closeFdOnFailure) {
      try {
        setCloseOnExec({ symbols: libc }, fd);
      } catch (error) {
        libc.close(fd);
        throw error;
      }
    }
  }
  // A non-duplicated descriptor remains caller-owned until mmap and the
  // JavaScript wrapper both succeed. The returned mapping owns it thereafter.
  return mapFd(fd, size, options.name, libc, closeFdOnFailure);
};

export const createNodeFfiSharedMemory = (
  options: number | CreateSharedMemoryOptions,
  library = openNodePosixLibrary(),
): SharedMemoryMapping<ArrayBuffer> => {
  const libc = library.functions;
  const size = expectPositiveSize(readCreateSize(options));
  const mode = readCreateMode(options);
  const name = mode === "anonymous"
    ? readCreateName(options, "knitting_shared_memory")
    : readRequiredCreateName(options);
  const platform = detectPosixPlatform();
  const fd = mode === "anonymous"
    ? createAnonymousFd(name, platform, libc)
    : createNamedFd(name, mode, platform, libc);

  if (mode !== "open" && libc.ftruncate(fd, BigInt(size)) < 0) {
    const error = posixError(
      "ftruncate failed",
      errnoOf(libc, platform),
      platform,
    );
    libc.close(fd);
    throw error;
  }
  return mapFd(
    fd,
    size,
    mode === "anonymous" ? undefined : name,
    libc,
    true,
  );
};

export const unlinkNodeFfiSharedMemory = (
  name: string,
  library = openNodePosixLibrary(),
): boolean => {
  const shmUnlink = library.functions.shm_unlink;
  if (shmUnlink === undefined) {
    throw new Error("shm_unlink symbol is not available");
  }
  return shmUnlink(encodeCString(toPosixSharedMemoryName(name))) === 0;
};

export const createNodeFfiPosixConnectionPrimitives = (
  library = openNodePosixLibrary(),
): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> => ({
  runtime: "node",
  createSharedMemory: (options) => createNodeFfiSharedMemory(options, library),
  mapSharedMemory: (options) => mapNodeFfiSharedMemory(options, library),
  unlinkSharedMemory: (name) => unlinkNodeFfiSharedMemory(name, library),
});

export const createNodeFfiConnectionPrimitives =
  (): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> =>
    isWindowsRuntime()
      ? createNodeWindowsConnectionPrimitives()
      : createNodeFfiPosixConnectionPrimitives();
