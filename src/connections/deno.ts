import {
  DARWIN_O_CREAT,
  DARWIN_O_EXCL,
  DARWIN_SHM_MODE,
  LINUX_O_CREAT,
  LINUX_O_EXCL,
  setCloseOnExec,
  detectPosixPlatform,
  encodeCString,
  getPosixLibcPath,
  makeDarwinSharedMemoryName,
  MAP_SHARED,
  O_RDWR,
  POSIX_SHM_MODE,
  type PosixPlatform,
  PROT_READ,
  PROT_WRITE,
  toPosixSharedMemoryName,
} from "./posix.ts";
import {
  type CreateSharedMemoryOptions,
  expectFd,
  expectPositiveSize,
  type MapSharedMemoryOptions,
  readCreateName,
  readCreateMode,
  readRequiredCreateName,
  readCreateSize,
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

export const openDenoLibc = (): DenoLibc =>
  getDeno().dlopen(getPosixLibcPath(), {
    ...getDenoCreateSymbols(),
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

const checkResult = (result: number, message: string): number => {
  if (result < 0) throw new Error(message);
  return result;
};

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
  const fd = checkResult(
    shmOpen(
      encodeCString(toPosixSharedMemoryName(name)),
      flags,
      platform === "darwin" ? DARWIN_SHM_MODE : POSIX_SHM_MODE,
    ),
    "shm_open failed",
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

  if (isDenoMmapFailed(pointer)) {
    if (options.duplicateFd !== false) libc.symbols.close(fd);
    throw new Error("mmap failed");
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
      checkResult(
        libc.symbols.ftruncate(fd, BigInt(size)),
        "ftruncate failed",
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
