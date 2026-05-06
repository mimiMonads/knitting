export type PosixPlatform = "linux" | "darwin";

export const LINUX_LIBC_SO = "libc.so.6";
export const DARWIN_LIBSYSTEM = "/usr/lib/libSystem.B.dylib";

export const PROT_READ = 1;
export const PROT_WRITE = 2;
export const MAP_SHARED = 1;

export const O_RDWR = 0x0002;
export const DARWIN_O_CREAT = 0x0200;
export const DARWIN_O_EXCL = 0x0800;
export const DARWIN_SHM_MODE = 0o600;

export const encodeCString = (value: string): Uint8Array =>
  new TextEncoder().encode(`${value}\0`);

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
