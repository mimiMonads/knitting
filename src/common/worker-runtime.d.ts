type RuntimePortMessageHandler = (message: unknown) => void;
export type RuntimeMessagePortLike = {
    postMessage: (message: unknown) => void;
    close?: () => void;
    start?: () => void;
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
    onmessage?: ((event: {
        data?: unknown;
    }) => void) | null;
    addEventListener?: (type: string, listener: (event: {
        data?: unknown;
        error?: unknown;
        message?: unknown;
    }) => void) => void;
    removeEventListener?: (type: string, listener: (event: {
        data?: unknown;
        error?: unknown;
        message?: unknown;
    }) => void) => void;
};
export type RuntimeWorkerLike = RuntimeMessagePortLike & {
    terminate: () => unknown;
};
export type RuntimeMessageChannelLike = {
    port1: RuntimeMessagePortLike;
    port2: RuntimeMessagePortLike;
};
export declare const RUNTIME_PROCESS_WORKER_ENV = "KNITTING_PROCESS_WORKER";
export declare const RUNTIME_PROCESS_WORKER_BOOT_ENV = "KNITTING_PROCESS_WORKER_BOOT";
export declare const RUNTIME_PROCESS_WORKER_BOOT_VERSION = 1;
export declare const RUNTIME_IS_PROCESS_WORKER: boolean;
export declare const RUNTIME_WORKER: new (specifier: string | URL, options?: Record<string, unknown>) => RuntimeWorkerLike;
export declare const RUNTIME_MESSAGE_CHANNEL: new () => RuntimeMessageChannelLike;
export declare const HAS_NODE_WORKER_THREADS: boolean;
export declare const RUNTIME_IS_MAIN_THREAD: boolean;
export declare const RUNTIME_WORKER_DATA: unknown;
export declare const RUNTIME_PARENT_PORT: RuntimeMessagePortLike;
export declare const createRuntimeMessageChannel: () => RuntimeMessageChannelLike;
export declare const addRuntimeDataListener: (target: RuntimeMessagePortLike, handler: RuntimePortMessageHandler) => void;
export {};
