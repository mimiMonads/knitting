import { type CreateSharedMemoryOptions, type MapSharedMemoryOptions, type SharedMemoryConnectionPrimitives, type SharedMemoryMapping } from "./types.js";
type DenoLibc = {
    symbols: {
        memfd_create?: (name: Uint8Array, flags: number) => number;
        shm_open?: (name: Uint8Array, flags: number, mode: number) => number;
        shm_unlink?: (name: Uint8Array) => number;
        ftruncate: (fd: number, length: bigint) => number;
        dup: (fd: number) => number;
        fcntl: (fd: number, cmd: number, arg: number) => number;
        mmap: (address: null, length: number, protection: number, flags: number, fd: number, offset: bigint) => unknown;
        munmap: (address: unknown, length: number) => number;
        close: (fd: number) => number;
    };
    close: () => void;
};
export declare const openDenoLibc: () => DenoLibc;
export declare const mapDenoSharedMemory: (options: MapSharedMemoryOptions, libc?: DenoLibc) => SharedMemoryMapping<ArrayBuffer>;
export declare const createDenoSharedMemory: (options: number | CreateSharedMemoryOptions, libc?: DenoLibc) => SharedMemoryMapping<ArrayBuffer>;
export declare const createDenoConnectionPrimitives: (libc?: DenoLibc) => SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>>;
export {};
