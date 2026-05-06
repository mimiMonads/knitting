import {
  type ConnectionRuntime,
  expectFd,
  expectPositiveSize,
  type MapSharedMemoryOptions,
  requireSharedArrayBuffer,
  type SharedMemoryConnectionPrimitives,
  type SharedMemoryMapping,
} from "./types.ts";

export type FileDescriptorMetadata = {
  version: 1;
  // fd values are process-local; across processes this assumes fd inheritance
  // or another fd-passing mechanism has made the same descriptor number valid.
  fd: number;
  size: number;
  byteLength: number;
  runtime?: ConnectionRuntime;
  kind?: SharedMemoryMapping["kind"];
  baseAddressMod64?: number;
};

type FileDescriptorMapper = Pick<
  SharedMemoryConnectionPrimitives,
  "mapSharedMemory"
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readOptionalRuntime = (
  value: unknown,
): ConnectionRuntime | undefined => {
  if (value === undefined) return undefined;
  if (value === "node" || value === "deno" || value === "bun") return value;

  throw new TypeError("file descriptor runtime is invalid");
};

const readOptionalKind = (
  value: unknown,
): SharedMemoryMapping["kind"] | undefined => {
  if (value === undefined) return undefined;
  if (
    value === "shared-array-buffer" ||
    value === "external-array-buffer"
  ) {
    return value;
  }

  throw new TypeError("file descriptor buffer kind is invalid");
};

const readOptionalNumber = (
  value: unknown,
  label: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`file descriptor ${label} must be a finite number`);
  }

  return Math.trunc(value);
};

export class FileDescriptor {
  readonly fd: number;
  readonly size: number;
  readonly byteLength: number;
  readonly runtime?: ConnectionRuntime;
  readonly kind?: SharedMemoryMapping["kind"];
  readonly baseAddressMod64?: number;

  #mapping?: SharedMemoryMapping;

  constructor(
    metadata: FileDescriptorMetadata,
    mapping?: SharedMemoryMapping,
  ) {
    this.fd = expectFd(metadata.fd);
    this.size = expectPositiveSize(metadata.size);
    this.byteLength = expectPositiveSize(metadata.byteLength);
    this.runtime = metadata.runtime;
    this.kind = metadata.kind;
    this.baseAddressMod64 = metadata.baseAddressMod64;
    this.#mapping = mapping;
  }

  static fromMapping(mapping: SharedMemoryMapping): FileDescriptor {
    return new FileDescriptor(
      {
        version: 1,
        fd: mapping.fd,
        size: mapping.size,
        byteLength: mapping.byteLength,
        runtime: mapping.runtime,
        kind: mapping.kind,
        baseAddressMod64: mapping.baseAddressMod64,
      },
      mapping,
    );
  }

  static fromMetadata(metadata: unknown): FileDescriptor {
    return new FileDescriptor(parseFileDescriptorMetadata(metadata));
  }

  static parse(serialized: string): FileDescriptor {
    return FileDescriptor.fromMetadata(serialized);
  }

  toMetadata(): FileDescriptorMetadata {
    return {
      version: 1,
      fd: this.fd,
      size: this.size,
      byteLength: this.byteLength,
      runtime: this.runtime,
      kind: this.kind,
      baseAddressMod64: this.baseAddressMod64,
    };
  }

  toJSON(): FileDescriptorMetadata {
    return this.toMetadata();
  }

  stringify(): string {
    return JSON.stringify(this.toMetadata());
  }

  stringifyMetadata(): string {
    // This describes an fd; it does not transfer fd ownership to another process.
    return this.stringify();
  }

  toString(): string {
    return this.stringify();
  }

  attach(mapping: SharedMemoryMapping): this {
    this.#mapping = mapping;
    return this;
  }

  get mapping(): SharedMemoryMapping | undefined {
    return this.#mapping;
  }

  map(mapper: FileDescriptorMapper): SharedMemoryMapping {
    const options: MapSharedMemoryOptions = {
      fd: this.fd,
      size: this.size,
    };
    this.#mapping = mapper.mapSharedMemory(options);
    return this.#mapping;
  }

  getSharedArrayBuffer(mapper?: FileDescriptorMapper): SharedArrayBuffer {
    if (this.#mapping?.sab !== undefined) return this.#mapping.sab;

    if (mapper === undefined) {
      throw new TypeError(
        "file descriptor is not attached to a SharedArrayBuffer mapping",
      );
    }

    return requireSharedArrayBuffer(this.map(mapper));
  }

  getSAB(mapper?: FileDescriptorMapper): SharedArrayBuffer {
    return this.getSharedArrayBuffer(mapper);
  }
}

export const parseFileDescriptorMetadata = (
  input: unknown,
): FileDescriptorMetadata => {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (!isRecord(value)) {
    throw new TypeError("file descriptor metadata must be an object");
  }

  if (value.version !== 1) {
    throw new TypeError("unsupported file descriptor metadata version");
  }

  return {
    version: 1,
    fd: expectFd(readOptionalNumber(value.fd, "fd") ?? -1),
    size: expectPositiveSize(readOptionalNumber(value.size, "size") ?? 0),
    byteLength: expectPositiveSize(
      readOptionalNumber(value.byteLength, "byteLength") ??
        readOptionalNumber(value.size, "size") ??
        0,
    ),
    runtime: readOptionalRuntime(value.runtime),
    kind: readOptionalKind(value.kind),
    baseAddressMod64: readOptionalNumber(
      value.baseAddressMod64,
      "baseAddressMod64",
    ),
  };
};
