import type {
  SharedBuffer,
  SharedBufferRegion,
} from "../common/shared-buffer-region.ts";
import { getNodeBuiltinModule } from "../common/node-compat.ts";
import {
  FileDescriptor,
  type FileDescriptorMetadata,
} from "./file-descriptor.ts";
import { RUNTIME } from "../common/runtime.ts";
import { createBunConnectionPrimitives } from "./bun.ts";
import { createDenoConnectionPrimitives } from "./deno.ts";
import { loadNodeNativeAddon } from "./node-addons.ts";
import {
  type CreateSharedMemoryOptions,
  expectFd,
  expectPositiveSize,
  readCreateMode,
  readCreateName,
  readRequiredCreateName,
  readCreateSize,
  type SharedMemoryConnectionPrimitives,
  type SharedMemoryMapping,
} from "./types.ts";

export type ProcessSharedBufferMetadata = {
  version: 1;
  descriptor: FileDescriptorMetadata;
  byteOffset: number;
  byteLength: number;
};

export const PROCESS_SHARED_BUFFER_BRAND = Symbol.for(
  "knitting.processSharedBuffer",
);
export const PROCESS_SHARED_BUFFER_NUMERIC_TRANSFER = Symbol.for(
  "knitting.processSharedBuffer.numericTransfer",
);
const EXTERNAL_PAYLOAD_BRAND = Symbol.for("knitting.payloadCodec");
const PROCESS_SHARED_BUFFER_CODEC_ID = "knitting.processSharedBuffer";

export type ProcessSharedBufferNumericMetadata = readonly [
  fd: number,
  size: number,
  descriptorByteLength: number,
  byteOffset: number,
  byteLength: number,
  runtime: number,
  kind: number,
  baseAddressMod64: number,
];

export type ProcessSharedBufferRange = {
  byteOffset?: number;
  byteLength?: number;
};

export type ProcessSharedBufferCreator = Pick<
  SharedMemoryConnectionPrimitives,
  "createSharedMemory"
>;

export type ProcessSharedBufferMapper = Pick<
  SharedMemoryConnectionPrimitives,
  "mapSharedMemory"
>;

export type ProcessSharedBufferPrimitives = Pick<
  SharedMemoryConnectionPrimitives,
  "createSharedMemory" | "mapSharedMemory"
> & {
  unlinkSharedMemory?: (name: string) => boolean;
};

export type ProcessSharedBufferView =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array;

export type ProcessSharedBufferViewConstructor<
  View extends ProcessSharedBufferView = ProcessSharedBufferView,
> = {
  readonly BYTES_PER_ELEMENT: number;
  new (
    buffer: SharedBuffer,
    byteOffset: number,
    length: number,
  ): View;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const NUMERIC_SENTINEL = 0xffffffff;
const RUNTIME_NODE = 1;
const RUNTIME_DENO = 2;
const RUNTIME_BUN = 3;
const KIND_SHARED_ARRAY_BUFFER = 1;
const KIND_EXTERNAL_ARRAY_BUFFER = 2;

const decodeRuntime = (
  value: number,
): FileDescriptorMetadata["runtime"] | undefined => {
  switch (value) {
    case RUNTIME_NODE:
      return "node";
    case RUNTIME_DENO:
      return "deno";
    case RUNTIME_BUN:
      return "bun";
    default:
      return undefined;
  }
};

const decodeKind = (
  value: number,
): FileDescriptorMetadata["kind"] | undefined => {
  switch (value) {
    case KIND_SHARED_ARRAY_BUFFER:
      return "shared-array-buffer";
    case KIND_EXTERNAL_ARRAY_BUFFER:
      return "external-array-buffer";
    default:
      return undefined;
  }
};

type NodeModuleBuiltin = {
  createRequire: (url: string) => (specifier: string) => unknown;
};

type DefaultNodeSharedMemoryNativeMapping = {
  sab: SharedArrayBuffer;
  fd: number;
  name?: string;
  size: number;
  baseAddressMod64?: number;
};

type DefaultNodeSharedMemoryAddon = {
  createSharedMemory: (
    size: number,
    name?: string,
    mode?: CreateSharedMemoryOptions["mode"],
  ) => DefaultNodeSharedMemoryNativeMapping;
  mapSharedMemory: (
    fd: number,
    size: number,
    name?: string,
  ) => DefaultNodeSharedMemoryNativeMapping;
  unlinkSharedMemory?: (name: string) => boolean;
};

let defaultPrimitives: ProcessSharedBufferPrimitives | undefined;

const fromDefaultNodeNativeMapping = (
  mapped: DefaultNodeSharedMemoryNativeMapping,
): SharedMemoryMapping<SharedArrayBuffer> => {
  const mapping: SharedMemoryMapping<SharedArrayBuffer> = {
    runtime: "node",
    fd: mapped.fd,
    size: mapped.size,
    byteLength: mapped.sab.byteLength,
    buffer: mapped.sab,
    kind: "shared-array-buffer",
    sab: mapped.sab,
    baseAddressMod64: mapped.baseAddressMod64,
  };
  if (mapped.name !== undefined && mapped.name.length > 0) {
    mapping.name = mapped.name;
  }
  return mapping;
};

const createDefaultNodePrimitives = (): ProcessSharedBufferPrimitives => {
  const nodeModule = getNodeBuiltinModule<NodeModuleBuiltin>("node:module");
  if (nodeModule === undefined) {
    throw new TypeError(
      "ProcessSharedBuffer needs connection primitives in this runtime",
    );
  }

  const require = nodeModule.createRequire(import.meta.url);
  const addon = loadNodeNativeAddon<DefaultNodeSharedMemoryAddon>(
    require,
    "knitting_shared_memory",
  );

  return {
    createSharedMemory: (options) => {
      const size = expectPositiveSize(readCreateSize(options));
      const mode = readCreateMode(options);
      const name = mode === "anonymous"
        ? readCreateName(options, "knitting_shared_memory")
        : readRequiredCreateName(options);
      return fromDefaultNodeNativeMapping(
        addon.createSharedMemory(size, name, mode),
      );
    },
    mapSharedMemory: (options) => {
      const fd = expectFd(options.fd);
      const size = expectPositiveSize(options.size);
      return fromDefaultNodeNativeMapping(
        addon.mapSharedMemory(fd, size, options.name),
      );
    },
  };
};

const createDefaultPrimitives = (): ProcessSharedBufferPrimitives => {
  if (RUNTIME === "bun") return createBunConnectionPrimitives();
  if (RUNTIME === "deno") return createDenoConnectionPrimitives();
  return createDefaultNodePrimitives();
};

export const setDefaultProcessSharedBufferPrimitives = (
  primitives: ProcessSharedBufferPrimitives | undefined,
): void => {
  defaultPrimitives = primitives;
};

export const getDefaultProcessSharedBufferPrimitives =
  (): ProcessSharedBufferPrimitives => {
    defaultPrimitives ??= createDefaultPrimitives();
    return defaultPrimitives;
  };

const expectNonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }

  return value;
};

const readOptionalNonNegativeInteger = (
  value: unknown,
  label: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new TypeError(`${label} must be a number`);
  }

  return expectNonNegativeInteger(value, label);
};

const expectRange = (
  byteOffset: number,
  byteLength: number,
  availableByteLength: number,
): void => {
  expectNonNegativeInteger(byteOffset, "process shared buffer byteOffset");

  if (byteOffset > availableByteLength) {
    throw new RangeError("process shared buffer byteOffset is out of bounds");
  }

  expectNonNegativeInteger(byteLength, "process shared buffer byteLength");

  if (byteLength > availableByteLength - byteOffset) {
    throw new RangeError("process shared buffer byteLength is out of bounds");
  }
};

export class ProcessSharedBuffer {
  readonly [PROCESS_SHARED_BUFFER_BRAND] = true;
  readonly [EXTERNAL_PAYLOAD_BRAND] = PROCESS_SHARED_BUFFER_CODEC_ID;
  readonly descriptor: FileDescriptor;
  readonly byteOffset: number;
  readonly byteLength: number;

  constructor(
    descriptor: FileDescriptor,
    range: ProcessSharedBufferRange = {},
  ) {
    const byteOffset = range.byteOffset ?? 0;
    const byteLength = range.byteLength ??
      descriptor.byteLength - byteOffset;

    expectRange(byteOffset, byteLength, descriptor.byteLength);

    this.descriptor = descriptor;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
  }

  static create(
    options: number | CreateSharedMemoryOptions,
    creator: ProcessSharedBufferCreator =
      getDefaultProcessSharedBufferPrimitives(),
  ): ProcessSharedBuffer {
    return ProcessSharedBuffer.fromMapping(creator.createSharedMemory(options));
  }

  static fromMapping(mapping: SharedMemoryMapping): ProcessSharedBuffer {
    return new ProcessSharedBuffer(FileDescriptor.fromMapping(mapping));
  }

  static fromDescriptor(
    descriptor: FileDescriptor,
    range: ProcessSharedBufferRange = {},
  ): ProcessSharedBuffer {
    return new ProcessSharedBuffer(descriptor, range);
  }

  static fromMetadata(metadata: unknown): ProcessSharedBuffer {
    const parsed = parseProcessSharedBufferMetadata(metadata);
    return new ProcessSharedBuffer(
      FileDescriptor.fromMetadata(parsed.descriptor),
      {
        byteOffset: parsed.byteOffset,
        byteLength: parsed.byteLength,
      },
    );
  }

  static parse(serialized: string): ProcessSharedBuffer {
    return ProcessSharedBuffer.fromMetadata(serialized);
  }

  static [PROCESS_SHARED_BUFFER_NUMERIC_TRANSFER](
    metadata: ProcessSharedBufferNumericMetadata,
  ): ProcessSharedBuffer {
    const [
      fd,
      size,
      descriptorByteLength,
      byteOffset,
      byteLength,
      runtime,
      kind,
      baseAddressMod64,
    ] = metadata;

    return new ProcessSharedBuffer(
      new FileDescriptor({
        version: 1,
        fd,
        size,
        byteLength: descriptorByteLength,
        runtime: decodeRuntime(runtime),
        kind: decodeKind(kind),
        baseAddressMod64: baseAddressMod64 === NUMERIC_SENTINEL
          ? undefined
          : baseAddressMod64,
      }),
      {
        byteOffset,
        byteLength,
      },
    );
  }

  get fd(): number {
    return this.descriptor.fd;
  }

  get size(): number {
    return this.descriptor.size;
  }

  subbuffer(byteOffset: number, byteLength?: number): ProcessSharedBuffer {
    const relativeByteOffset = expectNonNegativeInteger(
      byteOffset,
      "process shared buffer subbuffer byteOffset",
    );
    const relativeByteLength = byteLength === undefined
      ? this.byteLength - relativeByteOffset
      : expectNonNegativeInteger(
        byteLength,
        "process shared buffer subbuffer byteLength",
      );

    expectRange(relativeByteOffset, relativeByteLength, this.byteLength);

    return new ProcessSharedBuffer(this.descriptor, {
      byteOffset: this.byteOffset + relativeByteOffset,
      byteLength: relativeByteLength,
    });
  }

  getSharedArrayBuffer(mapper?: ProcessSharedBufferMapper): SharedArrayBuffer {
    return this.descriptor.getSAB(
      mapper ??
        (this.descriptor.mapping?.sab === undefined
          ? getDefaultProcessSharedBufferPrimitives()
          : undefined),
    );
  }

  getSAB(mapper?: ProcessSharedBufferMapper): SharedArrayBuffer {
    return this.getSharedArrayBuffer(mapper);
  }

  getBuffer(mapper?: ProcessSharedBufferMapper): SharedBuffer {
    return this.descriptor.getBuffer(
      mapper ??
        (this.descriptor.mapping?.buffer === undefined
          ? getDefaultProcessSharedBufferPrimitives()
          : undefined),
    );
  }

  getRegion(mapper?: ProcessSharedBufferMapper): SharedBufferRegion {
    return {
      sab: this.getBuffer(mapper),
      byteOffset: this.byteOffset,
      byteLength: this.byteLength,
    };
  }

  view<View extends ProcessSharedBufferView>(
    constructor: ProcessSharedBufferViewConstructor<View>,
    mapper?: ProcessSharedBufferMapper,
  ): View {
    const bytesPerElement = constructor.BYTES_PER_ELEMENT;
    if (this.byteOffset % bytesPerElement !== 0) {
      throw new RangeError(
        "process shared buffer byteOffset is not aligned for this view",
      );
    }

    if (this.byteLength % bytesPerElement !== 0) {
      throw new RangeError(
        "process shared buffer byteLength is not aligned for this view",
      );
    }

    return new constructor(
      this.getBuffer(mapper),
      this.byteOffset,
      this.byteLength / bytesPerElement,
    );
  }

  bytes(mapper?: ProcessSharedBufferMapper): Uint8Array {
    return this.view(Uint8Array, mapper);
  }

  dataView(mapper?: ProcessSharedBufferMapper): DataView {
    return new DataView(
      this.getBuffer(mapper),
      this.byteOffset,
      this.byteLength,
    );
  }

  toMetadata(): ProcessSharedBufferMetadata {
    return {
      version: 1,
      descriptor: this.descriptor.toMetadata(),
      byteOffset: this.byteOffset,
      byteLength: this.byteLength,
    };
  }

  toJSON(): ProcessSharedBufferMetadata {
    return this.toMetadata();
  }

  stringify(): string {
    return JSON.stringify(this.toMetadata());
  }

  stringifyMetadata(): string {
    return this.stringify();
  }

  toString(): string {
    return this.stringify();
  }
}

export const parseProcessSharedBufferMetadata = (
  input: unknown,
): ProcessSharedBufferMetadata => {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (!isRecord(value)) {
    throw new TypeError("process shared buffer metadata must be an object");
  }

  if (value.version !== 1) {
    throw new TypeError("unsupported process shared buffer metadata version");
  }

  const descriptor = FileDescriptor.fromMetadata(value.descriptor);
  const byteOffset = readOptionalNonNegativeInteger(
    value.byteOffset,
    "process shared buffer byteOffset",
  ) ?? 0;
  const byteLength = readOptionalNonNegativeInteger(
    value.byteLength,
    "process shared buffer byteLength",
  ) ?? descriptor.byteLength - byteOffset;

  expectRange(byteOffset, byteLength, descriptor.byteLength);

  return {
    version: 1,
    descriptor: descriptor.toMetadata(),
    byteOffset,
    byteLength,
  };
};

const processSharedBufferGlobal = globalThis as typeof globalThis & {
  __KNITTING_PAYLOAD_CODECS__?: Record<
    string,
    {
      decode: (metadata: unknown) => unknown;
      decodeNumeric?: (metadata: ArrayLike<number>) => unknown;
    } | undefined
  >;
};

const codecs = processSharedBufferGlobal.__KNITTING_PAYLOAD_CODECS__ ??=
  Object.create(null) as Record<
    string,
    {
      decode: (metadata: unknown) => unknown;
      decodeNumeric?: (metadata: ArrayLike<number>) => unknown;
    } | undefined
  >;
codecs[PROCESS_SHARED_BUFFER_CODEC_ID] = {
  decode: (metadata) => ProcessSharedBuffer.fromMetadata(metadata),
  decodeNumeric: (metadata) =>
    ProcessSharedBuffer[PROCESS_SHARED_BUFFER_NUMERIC_TRANSFER](
      metadata as ProcessSharedBufferNumericMetadata,
    ),
};
