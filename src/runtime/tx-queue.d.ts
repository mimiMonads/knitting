import { type Task, type Lock2 } from "../memory/lock.js";
import type { AbortSignalOption, TaskTimeout } from "../types.js";
import { type SignalAbortStore } from "../shared/abortSignal.js";
type RawArguments = unknown;
type FunctionID = number;
type QueueTask = Task;
export type MultiQueue = ReturnType<typeof createHostTxQueue>;
type CreateHostTxQueueArgs = {
    max?: number;
    lock: Lock2;
    returnLock: Lock2;
    abortSignals?: Pick<SignalAbortStore, "getSignal" | "resetSignal" | "closeNow">;
    now?: () => number;
};
export declare function createHostTxQueue({ max, lock, returnLock, abortSignals, now, }: CreateHostTxQueueArgs): {
    rejectAll: (reason: string) => void;
    hasPendingFrames: () => boolean;
    txIdle: () => boolean;
    completeFrame: () => number;
    enqueue: (functionID: FunctionID, timeout?: TaskTimeout, abortSignal?: AbortSignalOption) => (rawArgs: RawArguments) => Promise<never> | import("../common/with-resolvers.js").PromiseWithMaybeReject<unknown>;
    flushToWorker: () => boolean;
    enqueueKnown: (task: QueueTask) => boolean;
    settlePromisePayload: (task: QueueTask, isRejected: boolean, value: unknown) => boolean;
};
export {};
