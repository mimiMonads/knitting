import { type ConnectionRuntime, type SharedMemoryBuffer, type SharedMemoryConnectionPrimitives, type SharedMemoryMapping } from "./types.js";
export type FileDescriptorMetadata = {
    version: 1;
    fd: number;
    size: number;
    byteLength: number;
    runtime?: ConnectionRuntime;
    kind?: SharedMemoryMapping["kind"];
    baseAddressMod64?: number;
};
type FileDescriptorMapper = Pick<SharedMemoryConnectionPrimitives, "mapSharedMemory">;
export declare class FileDescriptor {
    #private;
    readonly fd: number;
    readonly size: number;
    readonly byteLength: number;
    readonly runtime?: ConnectionRuntime;
    readonly kind?: SharedMemoryMapping["kind"];
    readonly baseAddressMod64?: number;
    constructor(metadata: FileDescriptorMetadata, mapping?: SharedMemoryMapping);
    static fromMapping(mapping: SharedMemoryMapping): FileDescriptor;
    static fromMetadata(metadata: unknown): FileDescriptor;
    static parse(serialized: string): FileDescriptor;
    toMetadata(): FileDescriptorMetadata;
    toJSON(): FileDescriptorMetadata;
    stringify(): string;
    stringifyMetadata(): string;
    toString(): string;
    attach(mapping: SharedMemoryMapping): this;
    get mapping(): SharedMemoryMapping | undefined;
    map(mapper: FileDescriptorMapper): SharedMemoryMapping;
    getBuffer(mapper?: FileDescriptorMapper): SharedMemoryBuffer;
    getSharedArrayBuffer(mapper?: FileDescriptorMapper): SharedArrayBuffer;
    getSAB(mapper?: FileDescriptorMapper): SharedArrayBuffer;
}
export declare const parseFileDescriptorMetadata: (input: unknown) => FileDescriptorMetadata;
export {};
