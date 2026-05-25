import type { WorkerCall, tasks } from "../types.js";
export declare const createInlineExecutor: ({ tasks, genTaskID, batchSize, }: {
    tasks: tasks;
    genTaskID: () => number;
    batchSize?: number;
}) => {
    readonly kills: () => Promise<void>;
    readonly call: ({ fnNumber }: WorkerCall) => (args: unknown) => import("../common/with-resolvers.js").PromiseWithMaybeReject<unknown>;
    readonly txIdle: () => boolean;
};
