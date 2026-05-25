export declare const CACHE_LINE_SIZE = 64;
export type ConnectionRuntime = "node" | "deno" | "bun";
export type SharedMemoryBuffer = ArrayBuffer | SharedArrayBuffer;
export type SharedMemoryBufferKind = "shared-array-buffer" | "external-array-buffer";
export type SharedMemoryCreateMode = "anonymous" | "create" | "open";
export type SharedMemoryMapping<Buffer extends SharedMemoryBuffer = SharedMemoryBuffer> = {
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
    /**
     * `anonymous` keeps the current fd-backed private mapping behavior.
     * `create` and `open` use a named shared-memory object so independent
     * processes can rendezvous by name.
     */
    mode?: SharedMemoryCreateMode;
    name?: string;
};
export type MapSharedMemoryOptions = {
    fd: number;
    size: number;
    duplicateFd?: boolean;
};
export type SharedMemoryConnectionPrimitives<Mapping extends SharedMemoryMapping = SharedMemoryMapping> = {
    runtime: ConnectionRuntime;
    createSharedMemory: (options: number | CreateSharedMemoryOptions) => Mapping;
    mapSharedMemory: (options: MapSharedMemoryOptions) => Mapping;
    unlinkSharedMemory?: (name: string) => boolean;
};
export declare const alignToCacheLine: (size: number) => number;
export declare const readCreateSize: (options: number | CreateSharedMemoryOptions) => number;
export declare const readCreateName: (options: number | CreateSharedMemoryOptions, fallback: string) => string;
export declare const readCreateMode: (options: number | CreateSharedMemoryOptions) => SharedMemoryCreateMode;
export declare const expectSharedMemoryName: (name: string) => string;
export declare const readRequiredCreateName: (options: number | CreateSharedMemoryOptions) => string;
export declare const expectPositiveSize: (size: number) => number;
export declare const expectFd: (fd: number) => number;
export declare const requireSharedArrayBuffer: (mapping: SharedMemoryMapping) => SharedArrayBuffer;
