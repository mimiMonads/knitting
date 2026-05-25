import { type Lock2 } from "../memory/lock.js";
import type { WorkerComposedWithKey } from "./task-loader.js";
import type { WorkerSettings } from "../types.js";
type ArgumentsForCreateWorkerQueue = {
    listOfFunctions: WorkerComposedWithKey[];
    workerOptions?: WorkerSettings;
    lock: Lock2;
    returnLock: Lock2;
    hasAborted?: (signal: number) => boolean;
    now?: () => number;
};
export type CreateWorkerRxQueue = ReturnType<typeof createWorkerRxQueue>;
export declare const createWorkerRxQueue: ({ listOfFunctions, workerOptions, lock, returnLock, hasAborted, now, }: ArgumentsForCreateWorkerQueue) => {
    hasCompleted: () => boolean;
    hasPending: () => boolean;
    writeBatch: (max: number) => number;
    serviceBatchImmediate: () => number;
    enqueueLock: () => boolean;
    hasAwaiting: () => boolean;
    getAwaiting: () => number;
};
export {};
