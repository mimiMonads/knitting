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
import {
  createDenoWindowsConnectionPrimitives,
  isWindowsRuntime,
} from "./windows.ts";

type DenoLibc = {
  symbols: {
    memfd_create?: (name: Uint8Array, flags: number) => number;
    shm_open?: (name: Uint8Array, flags: number, mode: number) => number;
    shm_unlink?: (name: Uint8Array) => number;
    __error?: () => unknown;
    __errno_location?: () => unknown;
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
    ) => unknown;
    munmap: (address: unknown, length: number) => number;
    close: (fd: number) => number;
  };
  close: () => void;
};

type DenoLike = {
  build?: { os?: string };
  dlopen: (path: string, symbols: Record<string, unknown>) => DenoLibc;
  UnsafePointer?: {
    value: (pointer: unknown) => bigint;
  };
  UnsafePointerView: new (pointer: unknown) => {
    getArrayBuffer: (byteLength: number) => ArrayBuffer;
  };
};

const getDeno = (): DenoLike => {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno;
  if (deno === undefined) {
    throw new Error("Deno shared memory primitives can only run in Deno");
  }

  return deno;
};

const getDenoErrnoSymbols = (platform = detectPosixPlatform()) => ({
  [getErrnoSymbolName(platform)]: {
    parameters: [],
    result: "pointer",
  },
});

export const openDenoLibc = (): DenoLibc =>
  getDeno().dlopen(getPosixLibcPath(), {
    ...getDenoCreateSymbols(),
    ...getDenoErrnoSymbols(),
    ftruncate: {
      parameters: ["i32", "i64"],
      result: "i32",
    },
    dup: {
      parameters: ["i32"],
      result: "i32",
    },
    fcntl: {
      parameters: ["i32", "i32", "i32"],
      result: "i32",
    },
    mmap: {
      parameters: ["pointer", "usize", "i32", "i32", "i32", "i64"],
      result: "pointer",
    },
    munmap: {
      parameters: ["pointer", "usize"],
      result: "i32",
    },
    close: {
      parameters: ["i32"],
      result: "i32",
    },
  });

const getDenoCreateSymbols = (platform = detectPosixPlatform()) =>
  platform === "darwin"
    ? {
      shm_open: {
        parameters: ["buffer", "i32", "u32"],
        result: "i32",
      },
      shm_unlink: {
        parameters: ["buffer"],
        result: "i32",
      },
    }
    : {
      memfd_create: {
        parameters: ["buffer", "u32"],
        result: "i32",
      },
      shm_open: {
        parameters: ["buffer", "i32", "u32"],
        result: "i32",
      },
      shm_unlink: {
        parameters: ["buffer"],
        result: "i32",
      },
    };

const errnoOf = (
  libc: DenoLibc,
  platform = detectPosixPlatform(),
): ErrnoReader =>
  makeErrnoReader(
    platform === "darwin"
      ? libc.symbols.__error
      : libc.symbols.__errno_location,
    (pointer) => new Int32Array(
      new (getDeno().UnsafePointerView)(pointer).getArrayBuffer(4),
    )[0],
  );

const isDenoMmapFailed = (pointer: unknown): boolean => {
  if (pointer === null) return true;

  const value = getDeno().UnsafePointer?.value(pointer);
  return value === -1n || value === BigInt.asUintN(64, -1n);
};

const createDenoSharedMemoryFd = (
  name: string,
  platform: PosixPlatform,
  libc: DenoLibc,
): number => {
  if (platform === "darwin") {
    const shmOpen = libc.symbols.shm_open;
    const shmUnlink = libc.symbols.shm_unlink;
    if (shmOpen === undefined || shmUnlink === undefined) {
      throw new Error("shm_open symbols are not available");
    }

    const shmName = encodeCString(makeDarwinSharedMemoryName(name, "deno"));
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

  const fd = checkPosixResult(
    memfdCreate(encodeCString(name), 0),
    "memfd_create failed",
    errnoOf(libc, platform),
    platform,
  );

  try {
    return setCloseOnExec(libc, fd);
  } catch (error) {
    libc.symbols.close(fd);
    throw error;
  }
};

const createNamedDenoSharedMemoryFd = (
  name: string,
  mode: "create" | "open",
  platform: PosixPlatform,
  libc: DenoLibc,
): number => {
  const shmOpen = libc.symbols.shm_open;
  if (shmOpen === undefined) {
    throw new Error("shm_open symbol is not available");
  }

  const createFlags = platform === "darwin" ? DARWIN_O_CREAT : LINUX_O_CREAT;
  const exclusiveFlags = platform === "darwin" ? DARWIN_O_EXCL : LINUX_O_EXCL;
  const flags = mode === "create"
    ? O_RDWR | createFlags | exclusiveFlags
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
    return setCloseOnExec(libc, fd);
  } catch (error) {
    libc.symbols.close(fd);
    throw error;
  }
};

export const mapDenoSharedMemory = (
  options: MapSharedMemoryOptions,
  libc = openDenoLibc(),
): SharedMemoryMapping<ArrayBuffer> => {
  const sourceFd = options.name === undefined ? expectFd(options.fd) : -1;
  const size = expectPositiveSize(options.size);
  let fd = sourceFd;
  if (options.name !== undefined) {
    fd = createNamedDenoSharedMemoryFd(
      options.name,
      "open",
      detectPosixPlatform(),
      libc,
    );
  } else if (options.duplicateFd !== false) {
    fd = checkPosixResult(
      libc.symbols.dup(sourceFd),
      "dup(fd) failed",
      errnoOf(libc),
    );
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

  if (isDenoMmapFailed(pointer)) {
    const error = posixError("mmap failed", errnoOf(libc));
    if (options.duplicateFd !== false) libc.symbols.close(fd);
    throw error;
  }

  const arrayBuffer = new (getDeno().UnsafePointerView)(pointer)
    .getArrayBuffer(size);

  return {
    runtime: "deno",
    fd,
    name: options.name,
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

export const createDenoSharedMemory = (
  options: number | CreateSharedMemoryOptions,
  libc = openDenoLibc(),
): SharedMemoryMapping<ArrayBuffer> => {
  const size = expectPositiveSize(readCreateSize(options));
  const mode = readCreateMode(options);
  const name = mode === "anonymous"
    ? readCreateName(options, "knitting_shared_memory")
    : readRequiredCreateName(options);
  const platform = detectPosixPlatform();
  const fd = mode === "anonymous"
    ? createDenoSharedMemoryFd(name, platform, libc)
    : createNamedDenoSharedMemoryFd(name, mode, platform, libc);

  try {
    if (mode !== "open") {
      checkPosixResult(
        libc.symbols.ftruncate(fd, BigInt(size)),
        "ftruncate failed",
        errnoOf(libc, platform),
        platform,
      );
    }

    const mapping = mapDenoSharedMemory({ fd, size, duplicateFd: false }, libc);
    if (mode !== "anonymous") {
      return { ...mapping, name };
    }
    return mapping;
  } catch (error) {
    libc.symbols.close(fd);
    throw error;
  }
};

export const unlinkDenoSharedMemory = (
  name: string,
  libc = openDenoLibc(),
): boolean => {
  const shmUnlink = libc.symbols.shm_unlink;
  if (shmUnlink === undefined) {
    throw new Error("shm_unlink symbol is not available");
  }
  return shmUnlink(encodeCString(toPosixSharedMemoryName(name))) === 0;
};

export const createDenoPosixConnectionPrimitives = (
  libc = openDenoLibc(),
): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> => ({
  runtime: "deno",
  createSharedMemory: (options) => createDenoSharedMemory(options, libc),
  mapSharedMemory: (options) => mapDenoSharedMemory(options, libc),
  unlinkSharedMemory: (name) => unlinkDenoSharedMemory(name, libc),
});

export const createDenoConnectionPrimitives = (
  libc?: DenoLibc,
): SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>> =>
  isWindowsRuntime()
    ? createDenoWindowsConnectionPrimitives()
    : createDenoPosixConnectionPrimitives(libc);
