import { endpointSymbol } from "./common/task-symbol.ts";
export type WorkerCall = {
  fnNumber: number;
};

export type WorkerInvoke = (args: Uint8Array) => Promise<unknown>;

export interface WorkerContext {
  txIdle(): boolean;
  send(): void;
  call(descriptor: WorkerCall): WorkerInvoke;
  fastCalling(descriptor: WorkerCall): WorkerInvoke;
  kills(): void;
}

export type CreateContext = WorkerContext;

export type WorkerData = {
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

export type LockBuffers = {
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

export type ValidInput =
  | bigint
  | void
  | JSONValue
  | Map<Serializable, Serializable>
  | Set<Serializable>
  | symbol
  | Uint8Array
  | Int32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | DataView
  | Error
  | Date;

export type Args = ValidInput | Serializable;

export type MaybePromise<T> = T | Promise<T>;

export type TaskInput = Args | PromiseLike<Args>;

export type TaskTimeout =
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

export type TaskFn<A extends TaskInput, B extends Args> = BivariantCallback<
  [Awaited<A>],
  MaybePromise<B>
>;

type TaskLike = { readonly f: (...args: any[]) => any };

export type Composed<A extends TaskInput = Args, B extends Args = Args> =
  & FixPoint<A, B>
  & SecondPart;

export type tasks = Record<string, Composed<any, any>>;

export type ComposedWithKey = Composed<any, any> & { name: string };

type PromiseWrapped<F extends (...args: any[]) => any> = (
  ...args: PromisifyArgs<Parameters<F>>
) => Promise<Awaited<ReturnType<F>>>;

type PromiseInput<T> = T | Promise<T>;

type PromisifyArgs<T extends unknown[]> = {
  [K in keyof T]: PromiseInput<T[K]>;
};

export type FunctionMapType<T extends Record<string, TaskLike>> = {
  [K in keyof T]: PromiseWrapped<T[K]["f"]>;
};

export interface FixPoint<A extends TaskInput, B extends Args> {
  readonly href?: string;
  readonly f: TaskFn<A, B>;
  readonly timeout?: TaskTimeout;
}

export type SecondPart = {
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

export type SingleTaskPool<
  A extends TaskInput = Args,
  B extends Args = Args,
> = {
  call: PromiseWrapped<TaskFn<A, B>>;
  fastCall: PromiseWrapped<TaskFn<A, B>>;
  send: () => void;
  shutdown: () => void;
};

export type Pool<T extends Record<string, TaskLike>> = {
  shutdown: () => void;
  call: FunctionMapType<T>;
  fastCall: FunctionMapType<T>;
  send: () => void;
};

export type ReturnFixed<
  A extends TaskInput = undefined,
  B extends Args = undefined,
> =
  & FixPoint<A, B>
  & SecondPart
  & {
    createPool: (options?: CreatePool) => SingleTaskPool<A, B>;
  };

export type External = unknown;

export type Inliner = {
  position?: "first" | "last";
  /**
   * Inline tasks per event loop tick.
   * Defaults to 1 when inliner is enabled.
   */
  batchSize?: number;
};

export type BalancerStrategy =
  | "robinRound"
  | "firstIdle"
  | "randomLane"
  | "firstIdleOrRandom";

export type Balancer =
  | BalancerStrategy
  | {
    strategy: BalancerStrategy;
  };

export type DebugOptions = {
  extras?: boolean;
  logMain?: boolean;
  //logThreads?: boolean;
  logHref?: boolean;
  logImportedUrl?: boolean;
};

export type WorkerSettings = {
  resolveAfterFinishingAll?: true;
  timers?: WorkerTimers;
};

export type WorkerTimers = {
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
   */
  pauseNanoseconds?: number;
};

export type DispatcherSettings = {
  /**
   * How many immediate notify loops before backoff kicks in.
   */
  stallFreeLoops?: number;
  /**
   * Max backoff delay (milliseconds).
   */
  maxBackoffMs?: number;
};

export type CreatePool = {
  threads?: number;
  inliner?: Inliner;
  balancer?: Balancer;
  worker?: WorkerSettings;
  dispatcher?: DispatcherSettings;
  debug?: DebugOptions;
  source?: string;
};

export type { Task } from "./memory/lock.ts";
export {
  LockBound,
  PayloadBuffer,
  PayloadSingal,
  TaskIndex,
} from "./memory/lock.ts";
export type { RegisterMalloc } from "./memory/regionRegistry.ts";
