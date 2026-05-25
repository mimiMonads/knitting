import { type Sab } from "../ipc/transport/shared-memory.js";
import { lock2 } from "../memory/lock.js";
import type { DebugOptions, DispatcherSettings, WorkerContext, WorkerData, WorkerSettings } from "../types.js";
import "../worker/loop.js";
import { type PayloadBufferOptions } from "../memory/payload-config.js";
type ProcessSharedMemoryNativeMapping = {
    sab: SharedArrayBuffer;
    fd: number;
    size: number;
    baseAddressMod64?: number;
};
type ProcessSharedMemoryBacking = ProcessSharedMemoryNativeMapping & {
    runtime: "node";
    buffer: SharedArrayBuffer;
    kind: "shared-array-buffer";
    byteLength: number;
};
export declare const spawnWorkerContext: ({ list, ids, sab, thread, debug, totalNumberOfThread, source, at, workerOptions, workerExecArgv, permission, host, payload, payloadInitialBytes, payloadMaxBytes, bufferMode, maxPayloadBytes, abortSignalCapacity, usesAbortSignal, }: {
    list: string[];
    ids: number[];
    at: number[];
    sab?: Sab;
    thread: number;
    debug?: DebugOptions;
    totalNumberOfThread: number;
    source?: string;
    workerOptions?: WorkerSettings;
    workerExecArgv?: string[];
    permission?: WorkerData["permission"];
    host?: DispatcherSettings;
    payload?: PayloadBufferOptions;
    payloadInitialBytes?: number;
    payloadMaxBytes?: number;
    bufferMode?: PayloadBufferOptions["mode"];
    maxPayloadBytes?: number;
    abortSignalCapacity?: number;
    usesAbortSignal?: boolean;
}) => WorkerContext & {
    lock: ReturnType<typeof lock2>;
    processSharedMemoryBackings?: readonly ProcessSharedMemoryBacking[];
};
export type CreateContext = WorkerContext;
export {};
