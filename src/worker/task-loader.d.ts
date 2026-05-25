import type { ComposedWithKey } from "../types.js";
import type { ResolvedPermissionProtocol } from "../permission/protocol.js";
type GetFunctionParams = {
    list: string[];
    ids: number[];
    at: number[];
    isWorker: boolean;
    permission?: ResolvedPermissionProtocol;
};
type WorkerCallable = (args: unknown, abortToolkit?: unknown) => unknown;
export declare const enum TimeoutKind {
    Reject = 0,
    Resolve = 1
}
export type TimeoutSpec = {
    ms: number;
    kind: TimeoutKind;
    value: unknown;
};
export type WorkerComposedWithKey = ComposedWithKey & {
    run: WorkerCallable;
    timeout?: TimeoutSpec;
};
export declare const getFunctions: ({ list, ids, at, permission }: GetFunctionParams) => Promise<WorkerComposedWithKey[]>;
export type GetFunctions = ReturnType<typeof getFunctions>;
export {};
