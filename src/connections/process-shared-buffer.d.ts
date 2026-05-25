import type { SharedBuffer, SharedBufferRegion } from "../common/shared-buffer-region.js";
import { FileDescriptor, type FileDescriptorMetadata } from "./file-descriptor.js";
import { type CreateSharedMemoryOptions, type SharedMemoryConnectionPrimitives, type SharedMemoryMapping } from "./types.js";
export type ProcessSharedBufferMetadata = {
    version: 1;
    descriptor: FileDescriptorMetadata;
    byteOffset: number;
    byteLength: number;
};
export declare const PROCESS_SHARED_BUFFER_BRAND: unique symbol;
export declare const PROCESS_SHARED_BUFFER_NUMERIC_TRANSFER: unique symbol;
declare const EXTERNAL_PAYLOAD_BRAND: unique symbol;
export type ProcessSharedBufferNumericMetadata = readonly [
    fd: number,
    size: number,
    descriptorByteLength: number,
    byteOffset: number,
    byteLength: number,
    runtime: number,
    kind: number,
    baseAddressMod64: number
];
export type ProcessSharedBufferRange = {
    byteOffset?: number;
    byteLength?: number;
};
export type ProcessSharedBufferCreator = Pick<SharedMemoryConnectionPrimitives, "createSharedMemory">;
export type ProcessSharedBufferMapper = Pick<SharedMemoryConnectionPrimitives, "mapSharedMemory">;
export type ProcessSharedBufferPrimitives = Pick<SharedMemoryConnectionPrimitives, "createSharedMemory" | "mapSharedMemory">;
export type ProcessSharedBufferView = Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | BigInt64Array | BigUint64Array | Float32Array | Float64Array;
export type ProcessSharedBufferViewConstructor<View extends ProcessSharedBufferView = ProcessSharedBufferView> = {
    readonly BYTES_PER_ELEMENT: number;
    new (buffer: SharedBuffer, byteOffset: number, length: number): View;
};
export declare const setDefaultProcessSharedBufferPrimitives: (primitives: ProcessSharedBufferPrimitives | undefined) => void;
export declare const getDefaultProcessSharedBufferPrimitives: () => ProcessSharedBufferPrimitives;
export declare class ProcessSharedBuffer {
    readonly [PROCESS_SHARED_BUFFER_BRAND] = true;
    readonly [EXTERNAL_PAYLOAD_BRAND] = "knitting.processSharedBuffer";
    readonly descriptor: FileDescriptor;
    readonly byteOffset: number;
    readonly byteLength: number;
    constructor(descriptor: FileDescriptor, range?: ProcessSharedBufferRange);
    static create(options: number | CreateSharedMemoryOptions, creator?: ProcessSharedBufferCreator): ProcessSharedBuffer;
    static fromMapping(mapping: SharedMemoryMapping): ProcessSharedBuffer;
    static fromDescriptor(descriptor: FileDescriptor, range?: ProcessSharedBufferRange): ProcessSharedBuffer;
    static fromMetadata(metadata: unknown): ProcessSharedBuffer;
    static parse(serialized: string): ProcessSharedBuffer;
    static [PROCESS_SHARED_BUFFER_NUMERIC_TRANSFER](metadata: ProcessSharedBufferNumericMetadata): ProcessSharedBuffer;
    get fd(): number;
    get size(): number;
    subbuffer(byteOffset: number, byteLength?: number): ProcessSharedBuffer;
    getSharedArrayBuffer(mapper?: ProcessSharedBufferMapper): SharedArrayBuffer;
    getSAB(mapper?: ProcessSharedBufferMapper): SharedArrayBuffer;
    getBuffer(mapper?: ProcessSharedBufferMapper): SharedBuffer;
    getRegion(mapper?: ProcessSharedBufferMapper): SharedBufferRegion;
    view<View extends ProcessSharedBufferView>(constructor: ProcessSharedBufferViewConstructor<View>, mapper?: ProcessSharedBufferMapper): View;
    bytes(mapper?: ProcessSharedBufferMapper): Uint8Array;
    dataView(mapper?: ProcessSharedBufferMapper): DataView;
    toMetadata(): ProcessSharedBufferMetadata;
    toJSON(): ProcessSharedBufferMetadata;
    stringify(): string;
    stringifyMetadata(): string;
    toString(): string;
}
export declare const parseProcessSharedBufferMetadata: (input: unknown) => ProcessSharedBufferMetadata;
export {};
