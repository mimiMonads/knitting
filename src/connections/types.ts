export const CACHE_LINE_SIZE = 64;

export type ConnectionRuntime = "node" | "deno" | "bun";

export type SharedMemoryBuffer = ArrayBuffer | SharedArrayBuffer;

export type SharedMemoryBufferKind =
  | "shared-array-buffer"
  | "external-array-buffer";

export type SharedMemoryMapping<
  Buffer extends SharedMemoryBuffer = SharedMemoryBuffer,
> = {
  runtime: ConnectionRuntime;
  fd: number;
  size: number;
  byteLength: number;
  buffer: Buffer;
  kind: SharedMemoryBufferKind;
  sab?: SharedArrayBuffer;
  arrayBuffer?: ArrayBuffer;
  baseAddressMod64?: number;
  unsafePointer?: unknown;
  close?: () => void;
};

export type CreateSharedMemoryOptions = {
  size: number;
  name?: string;
};

export type MapSharedMemoryOptions = {
  fd: number;
  size: number;
  duplicateFd?: boolean;
};

export type SharedMemoryConnectionPrimitives<
  Mapping extends SharedMemoryMapping = SharedMemoryMapping,
> = {
  runtime: ConnectionRuntime;
  createSharedMemory: (
    options: number | CreateSharedMemoryOptions,
  ) => Mapping;
  mapSharedMemory: (
    options: MapSharedMemoryOptions,
  ) => Mapping;
};

export const alignToCacheLine = (size: number): number =>
  size + ((CACHE_LINE_SIZE - (size % CACHE_LINE_SIZE)) % CACHE_LINE_SIZE);

export const readCreateSize = (
  options: number | CreateSharedMemoryOptions,
): number => typeof options === "number" ? options : options.size;

export const readCreateName = (
  options: number | CreateSharedMemoryOptions,
  fallback: string,
): string => typeof options === "number" ? fallback : options.name ?? fallback;

export const expectPositiveSize = (size: number): number => {
  if (!Number.isFinite(size) || size <= 0) {
    throw new RangeError("shared memory size must be positive");
  }

  return alignToCacheLine(Math.trunc(size));
};

export const expectFd = (fd: number): number => {
  if (!Number.isInteger(fd) || fd < 0) {
    throw new RangeError("shared memory fd must be non-negative");
  }

  return fd;
};

export const requireSharedArrayBuffer = (
  mapping: SharedMemoryMapping,
): SharedArrayBuffer => {
  if (mapping.sab !== undefined) return mapping.sab;

  throw new TypeError(
    `${mapping.runtime} mapping is ${mapping.kind}; a native SAB wrapper is required`,
  );
};
