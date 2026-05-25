import { expectFd, expectPositiveSize, requireSharedArrayBuffer, } from "./types.js";
const isRecord = (value) => typeof value === "object" && value !== null;
const readOptionalRuntime = (value) => {
    if (value === undefined)
        return undefined;
    if (value === "node" || value === "deno" || value === "bun")
        return value;
    throw new TypeError("file descriptor runtime is invalid");
};
const readOptionalKind = (value) => {
    if (value === undefined)
        return undefined;
    if (value === "shared-array-buffer" ||
        value === "external-array-buffer") {
        return value;
    }
    throw new TypeError("file descriptor buffer kind is invalid");
};
const readOptionalNumber = (value, label) => {
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`file descriptor ${label} must be a finite number`);
    }
    return Math.trunc(value);
};
export class FileDescriptor {
    fd;
    size;
    byteLength;
    runtime;
    kind;
    baseAddressMod64;
    #mapping;
    constructor(metadata, mapping) {
        this.fd = expectFd(metadata.fd);
        this.size = expectPositiveSize(metadata.size);
        this.byteLength = expectPositiveSize(metadata.byteLength);
        this.runtime = metadata.runtime;
        this.kind = metadata.kind;
        this.baseAddressMod64 = metadata.baseAddressMod64;
        this.#mapping = mapping;
    }
    static fromMapping(mapping) {
        return new FileDescriptor({
            version: 1,
            fd: mapping.fd,
            size: mapping.size,
            byteLength: mapping.byteLength,
            runtime: mapping.runtime,
            kind: mapping.kind,
            baseAddressMod64: mapping.baseAddressMod64,
        }, mapping);
    }
    static fromMetadata(metadata) {
        return new FileDescriptor(parseFileDescriptorMetadata(metadata));
    }
    static parse(serialized) {
        return FileDescriptor.fromMetadata(serialized);
    }
    toMetadata() {
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
    toJSON() {
        return this.toMetadata();
    }
    stringify() {
        return JSON.stringify(this.toMetadata());
    }
    stringifyMetadata() {
        // This describes an fd; it does not transfer fd ownership to another process.
        return this.stringify();
    }
    toString() {
        return this.stringify();
    }
    attach(mapping) {
        this.#mapping = mapping;
        return this;
    }
    get mapping() {
        return this.#mapping;
    }
    map(mapper) {
        const options = {
            fd: this.fd,
            size: this.size,
        };
        this.#mapping = mapper.mapSharedMemory(options);
        return this.#mapping;
    }
    getBuffer(mapper) {
        if (this.#mapping?.buffer !== undefined)
            return this.#mapping.buffer;
        if (mapper === undefined) {
            throw new TypeError("file descriptor is not attached to a shared memory mapping");
        }
        return this.map(mapper).buffer;
    }
    getSharedArrayBuffer(mapper) {
        if (this.#mapping?.sab !== undefined)
            return this.#mapping.sab;
        if (mapper === undefined) {
            throw new TypeError("file descriptor is not attached to a SharedArrayBuffer mapping");
        }
        return requireSharedArrayBuffer(this.map(mapper));
    }
    getSAB(mapper) {
        return this.getSharedArrayBuffer(mapper);
    }
}
export const parseFileDescriptorMetadata = (input) => {
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
        byteLength: expectPositiveSize(readOptionalNumber(value.byteLength, "byteLength") ??
            readOptionalNumber(value.size, "size") ??
            0),
        runtime: readOptionalRuntime(value.runtime),
        kind: readOptionalKind(value.kind),
        baseAddressMod64: readOptionalNumber(value.baseAddressMod64, "baseAddressMod64"),
    };
};
