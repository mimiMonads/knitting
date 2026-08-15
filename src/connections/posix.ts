export type PosixPlatform = "linux" | "darwin";

export const LINUX_LIBC_SO = "libc.so.6";
export const DARWIN_LIBSYSTEM = "/usr/lib/libSystem.B.dylib";

export const PROT_READ = 1;
export const PROT_WRITE = 2;
export const MAP_SHARED = 1;

export const O_RDWR = 0x0002;
export const LINUX_O_CREAT = 0x0040;
export const LINUX_O_EXCL = 0x0080;
export const DARWIN_O_CREAT = 0x0200;
export const DARWIN_O_EXCL = 0x0800;
export const DARWIN_SHM_MODE = 0o600;
export const POSIX_SHM_MODE = 0o600;
export const F_GETFD = 1;
export const F_SETFD = 2;
export const FD_CLOEXEC = 1;

export const encodeCString = (value: string): Uint8Array =>
  new TextEncoder().encode(`${value}\0`);

// libc exposes errno through a function returning its address: `__error()` on
// macOS, `__errno_location()` on Linux. FFI callers read the int behind it to
// turn a bare -1 into something diagnosable.
export const getErrnoSymbolName = (
  platform: PosixPlatform,
): string => platform === "darwin" ? "__error" : "__errno_location";

// Only the codes shm_open/mmap/ftruncate/dup realistically return; anything
// else prints as a bare number.
const ERRNO_NAMES: Record<number, string> = {
  1: "EPERM",
  2: "ENOENT",
  9: "EBADF",
  12: "ENOMEM",
  13: "EACCES",
  17: "EEXIST",
  22: "EINVAL",
  24: "EMFILE",
  28: "ENOSPC",
};

const PLATFORM_ERRNO_NAMES: Record<PosixPlatform, Record<number, string>> = {
  darwin: { 45: "ENOTSUP", 63: "ENAMETOOLONG" },
  linux: { 36: "ENAMETOOLONG", 95: "ENOTSUP" },
};

/** Best effort: the runtime can issue its own libc call before errno is read. */
export type ErrnoReader = () => number | undefined;

const isNullPointer = (pointer: unknown): boolean =>
  pointer === null || pointer === undefined || pointer === 0 || pointer === 0n;

/**
 * Wraps a bound `__error`/`__errno_location` into a reader that never throws.
 * Runtimes differ only in how they turn the returned address into an int.
 */
export const makeErrnoReader = <Pointer>(
  locate: (() => Pointer) | undefined,
  readInt32: (pointer: Pointer) => number,
): ErrnoReader => {
  if (locate === undefined) return () => undefined;

  return () => {
    try {
      const pointer = locate();
      return isNullPointer(pointer) ? undefined : readInt32(pointer);
    } catch {
      return undefined;
    }
  };
};

const describeErrno = (
  errno: number | undefined,
  platform: PosixPlatform,
): string => {
  if (errno === undefined) return "errno unavailable";

  const name = PLATFORM_ERRNO_NAMES[platform][errno] ?? ERRNO_NAMES[errno];
  return name === undefined ? `errno ${errno}` : `${name} (${errno})`;
};

/** Builds `<message>: EACCES (13)`, reading errno as late as possible. */
export const posixError = (
  message: string,
  errno: ErrnoReader,
  platform = detectPosixPlatform(),
): Error => new Error(`${message}: ${describeErrno(errno(), platform)}`);

export const checkPosixResult = (
  result: number,
  message: string,
  errno?: ErrnoReader,
  platform?: PosixPlatform,
): number => {
  if (result < 0) {
    throw errno === undefined
      ? new Error(message)
      : posixError(message, errno, platform);
  }

  return result;
};

type FcntlLibc = {
  symbols: {
    fcntl: (fd: number, cmd: number, arg: number) => number;
  };
};

type SharedMemoryModeLibc = {
  symbols: {
    fchmod: (fd: number, mode: number) => number;
    close: (fd: number) => number;
  };
};

/**
 * Restores the mode on a freshly created macOS shared memory segment.
 *
 * macOS declares `shm_open(const char *, int, ...)` as variadic, and Apple's
 * arm64 ABI passes variadic arguments on the stack rather than in registers.
 * Every FFI engine here emits a fixed-arity call, so the mode argument lands in
 * a register the callee never reads and the segment is created with whatever
 * the stack happened to hold. The creator keeps a working descriptor either
 * way, so the damage only surfaces later: a second process opening the same
 * name with O_RDWR fails the permission check with EACCES.
 *
 * `fchmod(2)` has a fixed prototype, so it sets the mode reliably regardless of
 * how the FFI engine lays out variadic arguments. No-ops off macOS, where the
 * mode argument arrives intact. Closes the descriptor before throwing.
 */
export const repairDarwinSharedMemoryMode = <T extends SharedMemoryModeLibc>(
  libc: T,
  fd: number,
  platform: PosixPlatform,
  errno: ErrnoReader,
  mode: number = POSIX_SHM_MODE,
): void => {
  if (platform !== "darwin" || libc.symbols.fchmod(fd, mode) >= 0) return;

  const error = posixError("fchmod(shared memory) failed", errno, platform);
  libc.symbols.close(fd);
  throw error;
};

export const setCloseOnExec = <T extends FcntlLibc>(
  libc: T,
  fd: number,
): number => {
  const flags = libc.symbols.fcntl(fd, F_GETFD, 0);
  if (flags < 0) {
    throw new Error("fcntl(F_GETFD) failed");
  }

  const result = libc.symbols.fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
  if (result < 0) {
    throw new Error("fcntl(F_SETFD) failed");
  }

  return fd;
};

export const shmOpenCreateFlag = (platform: PosixPlatform): number =>
  platform === "darwin" ? DARWIN_O_CREAT : LINUX_O_CREAT;

export const shmOpenExclusiveFlag = (platform: PosixPlatform): number =>
  platform === "darwin" ? DARWIN_O_EXCL : LINUX_O_EXCL;

// macOS limits POSIX shared memory names to 31 characters including the
// leading "/", so the usable name portion is at most 30 characters.
export const POSIX_SHM_MAX_NAME_LEN = 30;

export const toPosixSharedMemoryName = (name: string): string => {
  if (name.length === 0) {
    throw new TypeError("shared memory name must be non-empty");
  }
  if (name.includes("\0")) {
    throw new TypeError("shared memory name must not contain NUL bytes");
  }

  const out = name.startsWith("/") ? name : `/${name}`;
  if (out.length < 2 || out.slice(1).includes("/")) {
    throw new TypeError(
      "POSIX shared memory name must not contain path separators",
    );
  }
  if (out.length > POSIX_SHM_MAX_NAME_LEN + 1) {
    throw new TypeError(
      `POSIX shared memory name must be at most ${POSIX_SHM_MAX_NAME_LEN} characters (macOS limit); got ${
        out.length - 1
      }`,
    );
  }

  return out;
};

export const detectPosixPlatform = (): PosixPlatform => {
  const denoOs = (globalThis as typeof globalThis & {
    Deno?: { build?: { os?: string } };
  }).Deno?.build?.os;
  if (denoOs === "darwin" || denoOs === "linux") return denoOs;

  const processPlatform = (globalThis as typeof globalThis & {
    process?: { platform?: string };
  }).process?.platform;
  if (processPlatform === "darwin" || processPlatform === "linux") {
    return processPlatform;
  }

  throw new Error("shared memory connections support Linux and macOS only");
};

export const assertPosixSharedMemoryPlatform = (feature: string): void => {
  try {
    detectPosixPlatform();
  } catch {
    throw new Error(`${feature} is supported on Linux and macOS only`);
  }
};

export const getPosixLibcPath = (platform = detectPosixPlatform()): string =>
  platform === "darwin" ? DARWIN_LIBSYSTEM : LINUX_LIBC_SO;

export const makeDarwinSharedMemoryName = (
  _name: string,
  runtime: string,
): string => {
  const processId = (globalThis as typeof globalThis & {
    process?: { pid?: number };
    Deno?: { pid?: number };
  }).process?.pid ??
    (globalThis as typeof globalThis & { Deno?: { pid?: number } }).Deno?.pid ??
    0;
  const runtimeTag = runtime.slice(0, 1) || "x";
  const pidTag = Math.abs(processId).toString(36).slice(-5);
  const timeTag = Date.now().toString(36).slice(-6);
  const nonce = Math.random().toString(36).slice(2, 6);

  return `/knit_${runtimeTag}_${pidTag}_${timeTag}_${nonce}`;
};
