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
export const encodeCString = (value) => new TextEncoder().encode(`${value}\0`);
export const setCloseOnExec = (libc, fd) => {
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
export const shmOpenCreateFlag = (platform) => platform === "darwin" ? DARWIN_O_CREAT : LINUX_O_CREAT;
export const shmOpenExclusiveFlag = (platform) => platform === "darwin" ? DARWIN_O_EXCL : LINUX_O_EXCL;
export const toPosixSharedMemoryName = (name) => {
    if (name.length === 0) {
        throw new TypeError("shared memory name must be non-empty");
    }
    if (name.includes("\0")) {
        throw new TypeError("shared memory name must not contain NUL bytes");
    }
    const out = name.startsWith("/") ? name : `/${name}`;
    if (out.length < 2 || out.slice(1).includes("/")) {
        throw new TypeError("POSIX shared memory name must not contain path separators");
    }
    return out;
};
export const detectPosixPlatform = () => {
    const denoOs = globalThis.Deno?.build?.os;
    if (denoOs === "darwin" || denoOs === "linux")
        return denoOs;
    const processPlatform = globalThis.process?.platform;
    if (processPlatform === "darwin" || processPlatform === "linux") {
        return processPlatform;
    }
    throw new Error("shared memory connections support Linux and macOS only");
};
export const assertPosixSharedMemoryPlatform = (feature) => {
    try {
        detectPosixPlatform();
    }
    catch {
        throw new Error(`${feature} is supported on Linux and macOS only`);
    }
};
export const getPosixLibcPath = (platform = detectPosixPlatform()) => platform === "darwin" ? DARWIN_LIBSYSTEM : LINUX_LIBC_SO;
export const makeDarwinSharedMemoryName = (_name, runtime) => {
    const processId = globalThis.process?.pid ??
        globalThis.Deno?.pid ??
        0;
    const runtimeTag = runtime.slice(0, 1) || "x";
    const pidTag = Math.abs(processId).toString(36).slice(-5);
    const timeTag = Date.now().toString(36).slice(-6);
    const nonce = Math.random().toString(36).slice(2, 6);
    return `/knit_${runtimeTag}_${pidTag}_${timeTag}_${nonce}`;
};
