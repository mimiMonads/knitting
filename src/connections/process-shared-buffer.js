import { getNodeBuiltinModule } from "../common/node-compat.js";
import { FileDescriptor, } from "./file-descriptor.js";
import { RUNTIME } from "../common/runtime.js";
import { createBunConnectionPrimitives } from "./bun.js";
import { createDenoConnectionPrimitives } from "./deno.js";
import { loadNodeNativeAddon } from "./node-addons.js";
import { assertPosixSharedMemoryPlatform } from "./posix.js";
import { expectFd, expectPositiveSize, readCreateMode, readCreateName, readRequiredCreateName, readCreateSize, } from "./types.js";
export const PROCESS_SHARED_BUFFER_BRAND = Symbol.for("knitting.processSharedBuffer");
export const PROCESS_SHARED_BUFFER_NUMERIC_TRANSFER = Symbol.for("knitting.processSharedBuffer.numericTransfer");
const EXTERNAL_PAYLOAD_BRAND = Symbol.for("knitting.payloadCodec");
const PROCESS_SHARED_BUFFER_CODEC_ID = "knitting.processSharedBuffer";
const isRecord = (value) => typeof value === "object" && value !== null;
const NUMERIC_SENTINEL = 0xffffffff;
const RUNTIME_NODE = 1;
const RUNTIME_DENO = 2;
const RUNTIME_BUN = 3;
const KIND_SHARED_ARRAY_BUFFER = 1;
const KIND_EXTERNAL_ARRAY_BUFFER = 2;
const decodeRuntime = (value) => {
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
const decodeKind = (value) => {
    switch (value) {
        case KIND_SHARED_ARRAY_BUFFER:
            return "shared-array-buffer";
        case KIND_EXTERNAL_ARRAY_BUFFER:
            return "external-array-buffer";
        default:
            return undefined;
    }
};
let defaultPrimitives;
const fromDefaultNodeNativeMapping = (mapped) => ({
    runtime: "node",
    fd: mapped.fd,
    size: mapped.size,
    byteLength: mapped.sab.byteLength,
    buffer: mapped.sab,
    kind: "shared-array-buffer",
    sab: mapped.sab,
    baseAddressMod64: mapped.baseAddressMod64,
});
const createDefaultNodePrimitives = () => {
    const nodeModule = getNodeBuiltinModule("node:module");
    if (nodeModule === undefined) {
        throw new TypeError("ProcessSharedBuffer needs connection primitives in this runtime");
    }
    const require = nodeModule.createRequire(import.meta.url);
    const addon = loadNodeNativeAddon(require, "knitting_shared_memory");
    return {
        createSharedMemory: (options) => {
            const size = expectPositiveSize(readCreateSize(options));
            const mode = readCreateMode(options);
            const name = mode === "anonymous"
                ? readCreateName(options, "knitting_shared_memory")
                : readRequiredCreateName(options);
            return fromDefaultNodeNativeMapping(addon.createSharedMemory(size, name, mode));
        },
        mapSharedMemory: (options) => {
            const fd = expectFd(options.fd);
            const size = expectPositiveSize(options.size);
            return fromDefaultNodeNativeMapping(addon.mapSharedMemory(fd, size));
        },
    };
};
const createDefaultPrimitives = () => {
    assertPosixSharedMemoryPlatform("ProcessSharedBuffer");
    if (RUNTIME === "bun")
        return createBunConnectionPrimitives();
    if (RUNTIME === "deno")
        return createDenoConnectionPrimitives();
    return createDefaultNodePrimitives();
};
export const setDefaultProcessSharedBufferPrimitives = (primitives) => {
    defaultPrimitives = primitives;
};
export const getDefaultProcessSharedBufferPrimitives = () => {
    defaultPrimitives ??= createDefaultPrimitives();
    return defaultPrimitives;
};
const expectNonNegativeInteger = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative integer`);
    }
    return value;
};
const readOptionalNonNegativeInteger = (value, label) => {
    if (value === undefined)
        return undefined;
    if (typeof value !== "number") {
        throw new TypeError(`${label} must be a number`);
    }
    return expectNonNegativeInteger(value, label);
};
const expectRange = (byteOffset, byteLength, availableByteLength) => {
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
    [PROCESS_SHARED_BUFFER_BRAND] = true;
    [EXTERNAL_PAYLOAD_BRAND] = PROCESS_SHARED_BUFFER_CODEC_ID;
    descriptor;
    byteOffset;
    byteLength;
    constructor(descriptor, range = {}) {
        const byteOffset = range.byteOffset ?? 0;
        const byteLength = range.byteLength ??
            descriptor.byteLength - byteOffset;
        expectRange(byteOffset, byteLength, descriptor.byteLength);
        this.descriptor = descriptor;
        this.byteOffset = byteOffset;
        this.byteLength = byteLength;
    }
    static create(options, creator = getDefaultProcessSharedBufferPrimitives()) {
        return ProcessSharedBuffer.fromMapping(creator.createSharedMemory(options));
    }
    static fromMapping(mapping) {
        return new ProcessSharedBuffer(FileDescriptor.fromMapping(mapping));
    }
    static fromDescriptor(descriptor, range = {}) {
        return new ProcessSharedBuffer(descriptor, range);
    }
    static fromMetadata(metadata) {
        const parsed = parseProcessSharedBufferMetadata(metadata);
        return new ProcessSharedBuffer(FileDescriptor.fromMetadata(parsed.descriptor), {
            byteOffset: parsed.byteOffset,
            byteLength: parsed.byteLength,
        });
    }
    static parse(serialized) {
        return ProcessSharedBuffer.fromMetadata(serialized);
    }
    static [PROCESS_SHARED_BUFFER_NUMERIC_TRANSFER](metadata) {
        const [fd, size, descriptorByteLength, byteOffset, byteLength, runtime, kind, baseAddressMod64,] = metadata;
        return new ProcessSharedBuffer(new FileDescriptor({
            version: 1,
            fd,
            size,
            byteLength: descriptorByteLength,
            runtime: decodeRuntime(runtime),
            kind: decodeKind(kind),
            baseAddressMod64: baseAddressMod64 === NUMERIC_SENTINEL
                ? undefined
                : baseAddressMod64,
        }), {
            byteOffset,
            byteLength,
        });
    }
    get fd() {
        return this.descriptor.fd;
    }
    get size() {
        return this.descriptor.size;
    }
    subbuffer(byteOffset, byteLength) {
        const relativeByteOffset = expectNonNegativeInteger(byteOffset, "process shared buffer subbuffer byteOffset");
        const relativeByteLength = byteLength === undefined
            ? this.byteLength - relativeByteOffset
            : expectNonNegativeInteger(byteLength, "process shared buffer subbuffer byteLength");
        expectRange(relativeByteOffset, relativeByteLength, this.byteLength);
        return new ProcessSharedBuffer(this.descriptor, {
            byteOffset: this.byteOffset + relativeByteOffset,
            byteLength: relativeByteLength,
        });
    }
    getSharedArrayBuffer(mapper) {
        return this.descriptor.getSAB(mapper ??
            (this.descriptor.mapping?.sab === undefined
                ? getDefaultProcessSharedBufferPrimitives()
                : undefined));
    }
    getSAB(mapper) {
        return this.getSharedArrayBuffer(mapper);
    }
    getBuffer(mapper) {
        return this.descriptor.getBuffer(mapper ??
            (this.descriptor.mapping?.buffer === undefined
                ? getDefaultProcessSharedBufferPrimitives()
                : undefined));
    }
    getRegion(mapper) {
        return {
            sab: this.getBuffer(mapper),
            byteOffset: this.byteOffset,
            byteLength: this.byteLength,
        };
    }
    view(constructor, mapper) {
        const bytesPerElement = constructor.BYTES_PER_ELEMENT;
        if (this.byteOffset % bytesPerElement !== 0) {
            throw new RangeError("process shared buffer byteOffset is not aligned for this view");
        }
        if (this.byteLength % bytesPerElement !== 0) {
            throw new RangeError("process shared buffer byteLength is not aligned for this view");
        }
        return new constructor(this.getBuffer(mapper), this.byteOffset, this.byteLength / bytesPerElement);
    }
    bytes(mapper) {
        return this.view(Uint8Array, mapper);
    }
    dataView(mapper) {
        return new DataView(this.getBuffer(mapper), this.byteOffset, this.byteLength);
    }
    toMetadata() {
        return {
            version: 1,
            descriptor: this.descriptor.toMetadata(),
            byteOffset: this.byteOffset,
            byteLength: this.byteLength,
        };
    }
    toJSON() {
        return this.toMetadata();
    }
    stringify() {
        return JSON.stringify(this.toMetadata());
    }
    stringifyMetadata() {
        return this.stringify();
    }
    toString() {
        return this.stringify();
    }
}
export const parseProcessSharedBufferMetadata = (input) => {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    if (!isRecord(value)) {
        throw new TypeError("process shared buffer metadata must be an object");
    }
    if (value.version !== 1) {
        throw new TypeError("unsupported process shared buffer metadata version");
    }
    const descriptor = FileDescriptor.fromMetadata(value.descriptor);
    const byteOffset = readOptionalNonNegativeInteger(value.byteOffset, "process shared buffer byteOffset") ?? 0;
    const byteLength = readOptionalNonNegativeInteger(value.byteLength, "process shared buffer byteLength") ?? descriptor.byteLength - byteOffset;
    expectRange(byteOffset, byteLength, descriptor.byteLength);
    return {
        version: 1,
        descriptor: descriptor.toMetadata(),
        byteOffset,
        byteLength,
    };
};
const processSharedBufferGlobal = globalThis;
const codecs = processSharedBufferGlobal.__KNITTING_PAYLOAD_CODECS__ ??=
    Object.create(null);
codecs[PROCESS_SHARED_BUFFER_CODEC_ID] = {
    decode: (metadata) => ProcessSharedBuffer.fromMetadata(metadata),
    decodeNumeric: (metadata) => ProcessSharedBuffer[PROCESS_SHARED_BUFFER_NUMERIC_TRANSFER](metadata),
};
