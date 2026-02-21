import { endpointSymbol } from "./common/task-symbol.ts";
import type { Buffer as NodeBuffer } from "node:buffer";
type WorkerCall = {
  fnNumber: number;
  timeout?: TaskTimeout;
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

type TaskFn<A extends TaskInput, B extends Args> = BivariantCallback<
  [NoBlob<Awaited<A>>],
  MaybePromise<NoBlob<B>>
>;

type TaskLike = { readonly f: (...args: any[]) => any };

type Composed<A extends TaskInput = Args, B extends Args = Args> =
  & FixPoint<A, B>
  & SecondPart;

type tasks = Record<string, Composed<any, any>>;

type ComposedWithKey = Composed<any, any> & { name: string };

type PromiseWrapped<F extends (...args: any[]) => any> = (
  ...args: PromisifyArgs<Parameters<F>>
) => Promise<Awaited<ReturnType<F>>>;

type PromiseInput<T> = T | Promise<T>;

type PromisifyArgs<T extends unknown[]> = {
  [K in keyof T]: PromiseInput<T[K]>;
};

type FunctionMapType<T extends Record<string, TaskLike>> = {
  [K in keyof T]: PromiseWrapped<T[K]["f"]>;
};

interface FixPoint<A extends TaskInput, B extends Args> {
  /**
   * Optional module URL override for worker discovery.
   * Unsafe/experimental: prefer default caller resolution.
   * May be removed in a future major release.
   */
  readonly href?: string;
  readonly f: TaskFn<A, B>;
  readonly timeout?: TaskTimeout;
}

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
> = {
  call: PromiseWrapped<TaskFn<A, B>>;
  shutdown: () => Promise<void>;
};

type Pool<T extends Record<string, TaskLike>> = {
  shutdown: () => Promise<void>;
  call: FunctionMapType<T>;
};

type ReturnFixed<
  A extends TaskInput = undefined,
  B extends Args = undefined,
> =
  & FixPoint<A, B>
  & SecondPart
  & {
    createPool: (options?: CreatePool) => SingleTaskPool<A, B>;
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
