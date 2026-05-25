import { type CreateSharedMemoryOptions, type MapSharedMemoryOptions, type SharedMemoryConnectionPrimitives, type SharedMemoryMapping } from "./types.js";
export type NodeSharedMemoryNativeMapping = {
    sab: SharedArrayBuffer;
    fd: number;
    size: number;
    baseAddressMod64?: number;
};
export type NodeSharedMemoryAddon = {
    createSharedMemory: (size: number, name?: string, mode?: CreateSharedMemoryOptions["mode"]) => NodeSharedMemoryNativeMapping;
    mapSharedMemory: (fd: number, size: number) => NodeSharedMemoryNativeMapping;
    unlinkSharedMemory?: (name: string) => boolean;
};
export type NodeFutexWaitResult = "woken" | "changed" | "interrupted" | "timed-out";
export type NodeFutexAddon = {
    waitU32: (buffer: ArrayBuffer | SharedArrayBuffer, byteOffset: number, expected: number, timeoutMs?: number) => NodeFutexWaitResult;
    wakeU32: (buffer: ArrayBuffer | SharedArrayBuffer, byteOffset: number, count?: number) => number;
    notifyU32?: (buffer: ArrayBuffer | SharedArrayBuffer, byteOffset: number, count?: number) => number;
    sleep?: (milliseconds?: number) => void;
    yield?: () => void;
};
export declare const DEFAULT_NODE_SHARED_MEMORY_ADDON = "../../build/Release/knitting_shared_memory.node";
export declare const DEFAULT_NODE_FUTEX_ADDON = "../../build/Release/knitting_shm.node";
export declare const loadNodeSharedMemoryAddon: (specifier?: string) => NodeSharedMemoryAddon;
export declare const loadNodeFutexAddon: (specifier?: string) => NodeFutexAddon;
export declare const fromNodeNativeMapping: (mapped: NodeSharedMemoryNativeMapping) => SharedMemoryMapping<SharedArrayBuffer>;
export declare const createNodeSharedMemory: (options: number | CreateSharedMemoryOptions, addon?: NodeSharedMemoryAddon) => SharedMemoryMapping<SharedArrayBuffer>;
export declare const mapNodeSharedMemory: (options: MapSharedMemoryOptions, addon?: NodeSharedMemoryAddon) => SharedMemoryMapping<SharedArrayBuffer>;
export declare const createNodeConnectionPrimitives: (addon?: NodeSharedMemoryAddon) => SharedMemoryConnectionPrimitives<SharedMemoryMapping<SharedArrayBuffer>>;
export declare const unlinkNodeSharedMemory: (name: string, addon?: NodeSharedMemoryAddon) => boolean;
