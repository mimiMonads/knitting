import { endpointSymbol } from "./common/task-symbol.ts";
import type { Buffer as NodeBuffer } from "node:buffer";
type WorkerCall = {
  fnNumber: number;
  timeout?: TaskTimeout;
  abortSignal?: AbortSignalOption;
};

type WorkerInvoke = (args: Uint8Array) => Promise<unknown>;

interface WorkerContext {
  txIdle(): boolean;
  call(descriptor: WorkerCall): WorkerInvoke;
  kills(): Promise<void>;
}

type CreateContext = WorkerContext;

type WorkerData = {
  sab: SharedArrayBuffer;
  abortSignalSAB?: SharedArrayBuffer;
  list: string[];
  ids: number[];
  thread: number;
  totalNumberOfThread: number;
  debug?: DebugOptions;
  startAt: number;
  workerOptions?: WorkerSettings;
  at: number[];
  lock: LockBuffers;
  returnLock: LockBuffers;
};

type LockBuffers = {
  headers: SharedArrayBuffer;
  lockSector: SharedArrayBuffer;
  payload: SharedArrayBuffer;
  payloadSector: SharedArrayBuffer;
};

// ──────────────────────────────────────────────────────────────────────────────
// Public API-facing contracts
// ──────────────────────────────────────────────────────────────────────────────

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONArray
  | JSONObject;

interface JSONObject {
  [key: string]: JSONValue;
}

interface JSONArray extends Array<JSONValue> {}

type Serializable = string | object | number | boolean | bigint;

type ValidInput =
  | bigint
  | void
  | JSONValue
  | symbol
  | NodeBuffer
  | ArrayBuffer
  | Uint8Array
  | Int32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | DataView
  | Error
  | Date;

type Args = ValidInput | Serializable;

type MaybePromise<T> = T | Promise<T>;

// Blob payloads are intentionally not supported by the transport.
type NoBlob<T> = T extends Blob ? never : T;

// Native Promise only. Thenables/PromiseLike values are treated as regular inputs.
type TaskInput = NoBlob<Args> | Promise<NoBlob<Args>>;

type TaskTimeout =
  | number
  | {
    time: number;
    maybe?: true;
    default?: unknown;
    error?: unknown;
  };

type BivariantCallback<Args extends unknown[], R> = {
  bivarianceHack(...args: Args): R;
}["bivarianceHack"];

type AbortSignalConfig =
  {
    readonly hasAborted: true;
  };

type AbortSignalOption = true | AbortSignalConfig | undefined;

type AbortSignalMethods<AS extends AbortSignalOption> =
  AS extends undefined
    ? never
    : {
      hasAborted: () => boolean;
    };

type AbortSignalToolkit<AS extends AbortSignalOption> = AbortSignalMethods<AS>;

type TaskFn<
  A extends TaskInput,
  B extends Args,
  AS extends AbortSignalOption = undefined,
> = BivariantCallback<
  AS extends undefined
    ? [NoBlob<Awaited<A>>]
    : [NoBlob<Awaited<A>>, AbortSignalToolkit<AS>],
  MaybePromise<NoBlob<B>>
>;

type PromiseWithMaybeReject<T> = Promise<T> & {
  reject?: (reason?: unknown) => void;
};

type TaskLike<AS extends AbortSignalOption = AbortSignalOption> = {
  readonly f: (...args: any[]) => any;
} & (
  AS extends undefined
    ? { readonly abortSignal?: undefined }
    : { readonly abortSignal: AS }
);

type Composed<
  A extends TaskInput = Args,
  B extends Args = Args,
  AS extends AbortSignalOption = undefined,
> =
  & FixPoint<A, B, AS>
  & SecondPart;

type tasks = Record<string, Composed<any, any, AbortSignalOption>>;

type ComposedWithKey = Composed<any, any, AbortSignalOption> & { name: string };

type PromiseWrapped<
  F extends (...args: any[]) => any,
  AS extends AbortSignalOption = undefined,
> = (
  ...args: PromisifyCallArgs<F, AS>
) => (
  AS extends undefined
    ? Promise<Awaited<ReturnType<F>>>
    : PromiseWithMaybeReject<Awaited<ReturnType<F>>>
);

type PromiseInput<T> = T | Promise<T>;

type PromisifyArgs<T extends unknown[]> = {
  [K in keyof T]: PromiseInput<T[K]>;
};

type NormalizeUndefinedSingleArg<T extends unknown[]> =
  T extends [undefined]
    ? [] | [undefined]
    : T;

type AbortAwareCallArgs<T extends unknown[]> =
  T extends [...infer Head, AbortSignalToolkit<any>]
    ? NormalizeUndefinedSingleArg<Head>
    : NormalizeUndefinedSingleArg<T>;

type HostCallArgs<
  F extends (...args: any[]) => any,
  AS extends AbortSignalOption,
> =
  AS extends undefined
    ? Parameters<F>
    : AbortAwareCallArgs<Parameters<F>>;

type PromisifyCallArgs<
  F extends (...args: any[]) => any,
  AS extends AbortSignalOption,
> =
  HostCallArgs<F, AS> extends infer T
    ? T extends unknown[]
      ? PromisifyArgs<T>
      : never
    : never;

type AbortSignalOfTask<T extends TaskLike<any>> =
  T extends { readonly abortSignal: infer AS }
    ? Extract<AS, AbortSignalOption>
    : undefined;

type FunctionMapType<T extends Record<string, TaskLike<any>>> = {
  [K in keyof T]: PromiseWrapped<
    T[K]["f"],
    AbortSignalOfTask<T[K]>
  >;
};

interface FixPointBase<
  A extends TaskInput,
  B extends Args,
  AS extends AbortSignalOption = undefined,
> {
  /**
   * Optional module URL override for worker discovery.
   * Unsafe/experimental: prefer default caller resolution.
   * May be removed in a future major release.
   */
  readonly href?: string;
  readonly f: TaskFn<A, B, AS>;
  readonly timeout?: TaskTimeout;
}

type FixPoint<
  A extends TaskInput,
  B extends Args,
  AS extends AbortSignalOption = undefined,
> =
  & FixPointBase<A, B, AS>
  & (
    AS extends undefined
      ? { readonly abortSignal?: undefined }
      : { readonly abortSignal: AS }
  );

type SecondPart = {
  readonly [endpointSymbol]: true;
  readonly id: number;
  /**
   * IMPORTANT: `at` helps to create a `createPool` because we dont know 
   * the name of the variable at runtime, so basically this gets the logical order
   * of the exported file, so no matter the name the worker can track which ` task `
   * to track
   */
  readonly at: number;
  readonly importedFrom: string;
};

type SingleTaskPool<
  A extends TaskInput = Args,
  B extends Args = Args,
  AS extends AbortSignalOption = undefined,
> = {
  call: PromiseWrapped<TaskFn<A, B, AS>, AS>;
  shutdown: () => Promise<void>;
};

type Pool<T extends Record<string, TaskLike<any>>> = {
  shutdown: () => Promise<void>;
  call: FunctionMapType<T>;
};

type ReturnFixed<
  A extends TaskInput = undefined,
  B extends Args = undefined,
  AS extends AbortSignalOption = undefined,
> =
  & FixPoint<A, B, AS>
  & SecondPart
  & {
    createPool: (options?: CreatePool) => SingleTaskPool<A, B, AS>;
  };

type External = unknown;

type Inliner = {
  position?: "first" | "last";
  /**
   * Inline tasks per event loop tick.
   * Defaults to 1 when inliner is enabled.
   */
  batchSize?: number;
  /**
   * Minimum in-flight calls before routing can use the inline host lane.
   * Defaults to 1 (inline lane available immediately).
   */
  dispatchThreshold?: number;
};

type BalancerStrategy =
  | "roundRobin"
  | "robinRound"
  | "firstIdle"
  | "randomLane"
  | "firstIdleOrRandom";

type Balancer =
  | BalancerStrategy
  | {
    /**
     * Optional. Defaults to "roundRobin".
     */
    strategy?: BalancerStrategy;
  };

type DebugOptions = {
  extras?: boolean;
  logMain?: boolean;
  //logThreads?: boolean;
  logHref?: boolean;
  logImportedUrl?: boolean;
};

type WorkerSettings = {
  resolveAfterFinishingAll?: true;
  timers?: WorkerTimers;
};

type WorkerTimers = {
  /**
   * Busy-spin budget before parking (microseconds).
   */
  spinMicroseconds?: number;
  /**
   * Atomics.wait timeout when parked (milliseconds).
   */
  parkMs?: number;
  /**
   * Atomics.pause duration during spin (nanoseconds).
   * Set to 0 (or less) to disable pause calls.
   */
  pauseNanoseconds?: number;
};

type DispatcherSettings = {
  /**
   * How many immediate notify loops before backoff kicks in.
   */
  stallFreeLoops?: number;
  /**
   * Max backoff delay (milliseconds).
   */
  maxBackoffMs?: number;
};

/**
 * @deprecated Use `host` in CreatePool instead.
 */
type DispatcherOptions = {
  host?: DispatcherSettings;
};

type CreatePool = {
  threads?: number;
  inliner?: Inliner;
  balancer?: Balancer;
  worker?: WorkerSettings;
  /**
   * Initial payload SharedArrayBuffer size (bytes) per worker direction.
   * Defaults to 4 MiB when growable SAB is available, otherwise defaults to
   * `payloadMaxBytes`.
   */
  payloadInitialBytes?: number;
  /**
   * Maximum payload SharedArrayBuffer size (bytes) per worker direction.
   * Defaults to 64 MiB.
   */
  payloadMaxBytes?: number;
  /**
   * Host dispatcher backoff and scheduling options.
   */
  host?: DispatcherSettings;
  /**
   * Extra Node.js execArgv flags for worker threads (e.g. ["--expose-gc"]).
   * Defaults to process.execArgv plus "--expose-gc" when allowed.
   */
  workerExecArgv?: string[];
  /**
   * @deprecated Use `host` instead.
   */
  dispatcher?: DispatcherOptions | DispatcherSettings;
  debug?: DebugOptions;
  source?: string;
};

// NOTE: Explicit export list with `as` keeps JSR type resolution stable,
// especially for curried APIs like `createPool`.
export type {
  WorkerCall as WorkerCall,
  WorkerInvoke as WorkerInvoke,
  WorkerContext as WorkerContext,
  CreateContext as CreateContext,
  WorkerData as WorkerData,
  LockBuffers as LockBuffers,
  ValidInput as ValidInput,
  Args as Args,
  MaybePromise as MaybePromise,
  TaskInput as TaskInput,
  TaskTimeout as TaskTimeout,
  TaskFn as TaskFn,
  AbortSignalConfig as AbortSignalConfig,
  AbortSignalOption as AbortSignalOption,
  AbortSignalMethods as AbortSignalMethods,
  AbortSignalToolkit as AbortSignalToolkit,
  Composed as Composed,
  tasks as tasks,
  ComposedWithKey as ComposedWithKey,
  FunctionMapType as FunctionMapType,
  FixPoint as FixPoint,
  SecondPart as SecondPart,
  SingleTaskPool as SingleTaskPool,
  Pool as Pool,
  ReturnFixed as ReturnFixed,
  External as External,
  Inliner as Inliner,
  BalancerStrategy as BalancerStrategy,
  Balancer as Balancer,
  DebugOptions as DebugOptions,
  WorkerSettings as WorkerSettings,
  WorkerTimers as WorkerTimers,
  DispatcherSettings as DispatcherSettings,
  DispatcherOptions as DispatcherOptions,
  CreatePool as CreatePool,
};
export type { Task as Task } from "./memory/lock.ts";
export {
  LockBound as LockBound,
  PayloadBuffer as PayloadBuffer,
  PayloadSignal as PayloadSignal,
  TaskIndex as TaskIndex,
} from "./memory/lock.ts";
export type { RegisterMalloc as RegisterMalloc } from "./memory/regionRegistry.ts";
