import {
  DARWIN_O_CREAT,
  DARWIN_O_EXCL,
  DARWIN_SHM_MODE,
  setCloseOnExec,
  detectPosixPlatform,
  encodeCString,
  getPosixLibcPath,
  makeDarwinSharedMemoryName,
  MAP_SHARED,
  O_RDWR,
  type PosixPlatform,
  PROT_READ,
  PROT_WRITE,
} from "./posix.ts";
import {
  type CreateSharedMemoryOptions,
  expectFd,
  expectPositiveSize,
  type MapSharedMemoryOptions,
  readCreateName,
  readCreateSize,
  type SharedMemoryConnectionPrimitives,
  type SharedMemoryMapping,
} from "./types.ts";
import {
  createBunWindowsConnectionPrimitives,
  isWindowsRuntime,
} from "./windows.ts";

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

const FFIType = {
  i32: 5,
  i64: 7,
  u32: 6,
  usize: 8,
  ptr: 12,
} as const;

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

type BunLibc = {
  symbols: {
    memfd_create?: (name: Uint8Array, flags: number) => number;
    shm_open?: (name: Uint8Array, flags: number, mode: number) => number;
    shm_unlink?: (name: Uint8Array) => number;
    ftruncate: (fd: number, length: bigint) => number;
    dup: (fd: number) => number;
    fcntl: (fd: number, cmd: number, arg: number) => number;
    mmap: (
      address: null,
      length: number,
      protection: number,
      flags: number,
      fd: number,
      offset: bigint,
    ) => BunPointer;
    munmap: (address: BunPointer, length: number) => number;
    close: (fd: number) => number;
  };
};

export const openBunLibc = (): BunLibc =>
  getBunFFI().dlopen(getPosixLibcPath(), {
    ...getBunCreateSymbols(),
    ftruncate: {
      args: [FFIType.i32, FFIType.i64],
      returns: FFIType.i32,
    },
    dup: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
    fcntl: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    mmap: {
      args: [
        FFIType.ptr,
        FFIType.usize,
        FFIType.i32,
        FFIType.i32,
        FFIType.i32,
        FFIType.i64,
      ],
      returns: FFIType.ptr,
    },
    munmap: {
      args: [FFIType.ptr, FFIType.usize],
      returns: FFIType.i32,
    },
    close: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
  }) as BunLibc;

const getBunCreateSymbols = (platform = detectPosixPlatform()) =>
  platform === "darwin"
    ? {
      shm_open: {
        args: [FFIType.ptr, FFIType.i32, FFIType.u32],
        returns: FFIType.i32,
      },
      shm_unlink: {
        args: [FFIType.ptr],
        returns: FFIType.i32,
      },
    }
    : {
      memfd_create: {
        args: [FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
    };

const checkResult = (result: number, message: string): number => {
  if (result < 0) throw new Error(message);
  return result;
};

const isBunMmapFailed = (pointer: BunPointer): boolean =>
  !pointer || pointer < 0 || pointer >= Number.MAX_SAFE_INTEGER;

const createBunSharedMemoryFd = (
  name: string,
  platform: PosixPlatform,
  libc: BunLibc,
): number => {
  if (platform === "darwin") {
    const shmOpen = libc.symbols.shm_open;
    const shmUnlink = libc.symbols.shm_unlink;
    if (shmOpen === undefined || shmUnlink === undefined) {
      throw new Error("shm_open symbols are not available");
    }

    const shmName = encodeCString(makeDarwinSharedMemoryName(name, "bun"));
    const fd = checkResult(
      shmOpen(
        shmName,
        O_RDWR | DARWIN_O_CREAT | DARWIN_O_EXCL,
        DARWIN_SHM_MODE,
      ),
      "shm_open failed",
    );

    shmUnlink(shmName);
    try {
      return setCloseOnExec(libc, fd);
    } catch (error) {
      libc.symbols.close(fd);
      throw error;
    }
  }

  const memfdCreate = libc.symbols.memfd_create;
  if (memfdCreate === undefined) {
    throw new Error("memfd_create symbol is not available");
  }

  const fd = checkResult(
    memfdCreate(encodeCString(name), 0),
    "memfd_create failed",
  );

  try {
    return setCloseOnExec(libc, fd);
  } catch (error) {
    libc.symbols.close(fd);
    throw error;
  }
};

export const mapBunSharedMemory = (
  options: MapSharedMemoryOptions,
  libc = openBunLibc(),
): SharedMemoryMapping<ArrayBuffer> => {
  const sourceFd = expectFd(options.fd);
  const size = expectPositiveSize(options.size);
  let fd = sourceFd;
  if (options.duplicateFd !== false) {
    fd = checkResult(libc.symbols.dup(sourceFd), "dup(fd) failed");
    try {
      setCloseOnExec(libc, fd);
    } catch (error) {
      libc.symbols.close(fd);
      throw error;
    }
  }
  const pointer = libc.symbols.mmap(
    null,
    size,
    PROT_READ | PROT_WRITE,
    MAP_SHARED,
    fd,
    0n,
  );

  if (isBunMmapFailed(pointer)) {
    if (options.duplicateFd !== false) libc.symbols.close(fd);
    throw new Error("mmap failed");
  }

  const arrayBuffer = getBunFFI().toArrayBuffer(pointer, 0, size);

  return {
    runtime: "bun",
    fd,
    size,
    byteLength: arrayBuffer.byteLength,
    buffer: arrayBuffer,
    kind: "external-array-buffer",
    arrayBuffer,
    unsafePointer: pointer,
    close: () => {
      libc.symbols.munmap(pointer, size);
      libc.symbols.close(fd);
    },
  };
};

export const createBunSharedMemory = (
  options: number | CreateSharedMemoryOptions,
  libc = openBunLibc(),
): SharedMemoryMapping<ArrayBuffer> => {
  const size = expectPositiveSize(readCreateSize(options));
  const name = readCreateName(options, "knitting_shared_memory");
  const fd = createBunSharedMemoryFd(name, detectPosixPlatform(), libc);

  try {
    checkResult(
      libc.symbols.ftruncate(fd, BigInt(size)),
      "ftruncate failed",
    );

    return mapBunSharedMemory({ fd, size, duplicateFd: false }, libc);
  } catch (error) {
    libc.symbols.close(fd);
    throw error;
  }
};

export const createBunPosixConnectionPrimitives = (
  libc = openBunLibc(),
): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> => ({
  runtime: "bun",
  createSharedMemory: (options) => createBunSharedMemory(options, libc),
  mapSharedMemory: (options) => mapBunSharedMemory(options, libc),
});

export const createBunConnectionPrimitives = (
  libc?: BunLibc,
): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> =>
  isWindowsRuntime()
    ? createBunWindowsConnectionPrimitives()
    : createBunPosixConnectionPrimitives(libc);
