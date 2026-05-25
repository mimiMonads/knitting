import { endpointSymbol } from "./common/task-symbol.js";
import type { Args, AbortSignalConfig, AbortSignalOption, AbortSignalToolkit, CreatePool, FixPoint, MaybePromise, Pool, TaskInput, ReturnFixed, ImportTaskOptions, TaskTimeout, tasks } from "./types.js";
type ToListAndIds = {
    list: string[];
    ids: number[];
    at: number[];
};
type ToListAndIdsFn = (args: tasks) => ToListAndIds;
type CreatePoolFactory = (options: CreatePool) => <T extends tasks>(tasks: T) => Pool<T>;
type InferredTaskFunction = (...args: any[]) => MaybePromise<Args>;
type InferredTaskInput<F extends InferredTaskFunction, AS extends AbortSignalOption> = Parameters<F> extends [] ? void : AS extends undefined ? Parameters<F> extends [infer A] ? A extends TaskInput ? A : never : never : Parameters<F> extends [infer A] ? A extends TaskInput ? A : never : Parameters<F> extends [infer A, AbortSignalToolkit<AS>] ? A extends TaskInput ? A : never : never;
type InferredTaskOutput<F extends InferredTaskFunction> = Awaited<ReturnType<F>> extends infer R ? R extends Blob ? never : R extends Args ? R : never : never;
type InferredTaskShape<F extends InferredTaskFunction, AS extends AbortSignalOption> = [
    InferredTaskInput<F, AS>
] extends [never] ? never : [InferredTaskOutput<F>] extends [never] ? never : {
    readonly f: F;
    readonly timeout?: TaskTimeout;
} & (AS extends undefined ? {
    readonly abortSignal?: undefined;
} : {
    readonly abortSignal: AS;
});
export declare const isMain: boolean;
export { endpointSymbol as endpointSymbol };
/**
 *  With this information we can recreate the logical order of
 *  relevant exported functions from a file, also it helps to
 *  track a task before naming, ` export ` elements have to be declared
 *  at top level and without branching, we take advantage of this to
 *  correctly map them.
 *
 */
export declare const toListAndIds: ToListAndIdsFn;
export declare const createPool: CreatePoolFactory;
/**
 * Define a worker task.
 *
 * Input may be a direct value or a native Promise of that value.
 * Thenables/PromiseLike values are treated as plain values.
 */
export declare function task<F extends InferredTaskFunction>(I: InferredTaskShape<F, undefined>): ReturnFixed<InferredTaskInput<F, undefined>, InferredTaskOutput<F>, undefined>;
export declare function task<F extends InferredTaskFunction>(I: InferredTaskShape<F, true>): ReturnFixed<InferredTaskInput<F, true>, InferredTaskOutput<F>, true>;
export declare function task<AS extends AbortSignalConfig, F extends InferredTaskFunction>(I: InferredTaskShape<F, AS>): ReturnFixed<InferredTaskInput<F, AS>, InferredTaskOutput<F>, AS>;
export declare function task<A extends TaskInput = void, B extends Args = void>(I: FixPoint<A, B, true>): ReturnFixed<A, B, true>;
export declare function task<A extends TaskInput = void, B extends Args = void, AS extends AbortSignalConfig = AbortSignalConfig>(I: FixPoint<A, B, AS>): ReturnFixed<A, B, AS>;
export declare function task<A extends TaskInput = void, B extends Args = void>(I: FixPoint<A, B, undefined>): ReturnFixed<A, B, undefined>;
/**
 * Define a task whose worker-side function is imported dynamically from `href`.
 *
 * This keeps module import/evaluation inside the worker, so worker permission
 * policies apply to that import path.
 */
export declare function importTask<A extends TaskInput = void, B extends Args = void>(options: ImportTaskOptions<A, B, true>): ReturnFixed<A, B, true>;
export declare function importTask<A extends TaskInput = void, B extends Args = void, AS extends AbortSignalConfig = AbortSignalConfig>(options: ImportTaskOptions<A, B, AS>): ReturnFixed<A, B, AS>;
export declare function importTask<A extends TaskInput = void, B extends Args = void>(options: ImportTaskOptions<A, B, undefined>): ReturnFixed<A, B, undefined>;
