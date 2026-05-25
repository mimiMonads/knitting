import { type CreateSharedMemoryOptions, type MapSharedMemoryOptions, type SharedMemoryConnectionPrimitives, type SharedMemoryMapping } from "./types.js";
type BunPointer = number;
type BunLibc = {
    symbols: {
        memfd_create?: (name: Uint8Array, flags: number) => number;
        shm_open?: (name: Uint8Array, flags: number, mode: number) => number;
        shm_unlink?: (name: Uint8Array) => number;
        ftruncate: (fd: number, length: bigint) => number;
        dup: (fd: number) => number;
        fcntl: (fd: number, cmd: number, arg: number) => number;
        mmap: (address: null, length: number, protection: number, flags: number, fd: number, offset: bigint) => BunPointer;
        munmap: (address: BunPointer, length: number) => number;
        close: (fd: number) => number;
    };
};
export declare const openBunLibc: () => BunLibc;
export declare const mapBunSharedMemory: (options: MapSharedMemoryOptions, libc?: BunLibc) => SharedMemoryMapping<ArrayBuffer>;
export declare const createBunSharedMemory: (options: number | CreateSharedMemoryOptions, libc?: BunLibc) => SharedMemoryMapping<ArrayBuffer>;
export declare const createBunConnectionPrimitives: (libc?: BunLibc) => SharedMemoryConnectionPrimitives<SharedMemoryMapping<ArrayBuffer>>;
export {};
