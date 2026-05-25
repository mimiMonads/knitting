import { type Task } from "../memory/lock.js";
import type { TimeoutSpec } from "./task-loader.js";
type WorkerJob = (args: unknown, abortToolkit?: unknown) => unknown;
type SlotRunner = (slot: Task) => unknown;
type HasAborted = (signal: number) => boolean;
export declare const composeWorkerRunner: ({ job, timeout, hasAborted, now, }: {
    job: WorkerJob;
    timeout?: TimeoutSpec;
    hasAborted?: HasAborted;
    now?: () => number;
}) => SlotRunner;
export {};
