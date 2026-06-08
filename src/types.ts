import { endpointSymbol } from "./common/task-symbol.ts";
import type {
  Envelope,
  EnvelopeBody,
  EnvelopeHeader,
} from "./common/envelope.ts";
import type {
  LockBufferTextCompat,
  SharedBufferTextCompat,
} from "./common/shared-buffer-text.ts";
import type {
  SharedBufferRegion,
  SharedBufferSource,
} from "./common/shared-buffer-region.ts";
import type {
  PayloadBufferMode,
  PayloadBufferOptions,
} from "./memory/payload-config.ts";
import type {
  PermissionProtocol,
  PermissionProtocolInput,
  ResolvedPermissionProtocol,
} from "./permission/protocol.ts";
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
  sab: SharedBufferSource;
  abortSignalSAB?: SharedBufferSource;
  abortSignalMax?: number;
  list: string[];
  ids: number[];
  names: string[];
  thread: number;
  totalNumberOfThread: number;
  debug?: DebugOptions;
  startAt: number;
  workerOptions?: WorkerSettings;
  at: number[];
  lock: LockBuffers;
  returnLock: LockBuffers;
  payloadConfig?: PayloadBufferOptions;
  bufferReferenceReturn?: "copy" | "borrow";
  permission?: ResolvedPermissionProtocol;
};

type UnsafeOptions = {
  /**
   * Experimental `BufferReference` return lifetime.
   *
   * `"copy"` is safe after worker release. `"borrow"` skips the Deno/Bun copy,
   * but must be released before producer shutdown and must not outlive its ref.
   */
  BufferReferenceReturn?: "copy" | "borrow";
};

type LockBuffers = {
  headers: SharedBufferSource;
  headerSlotStrideU32?: number;
  lockSector: SharedBufferSource;
  payload: SharedBufferSource;
  payloadSector: SharedBufferSource;
  textCompat?: LockBufferTextCompat;
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
  | ArrayBuffer
  | Uint8Array
  | Int32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | DataView
  | Error
  | Date
  | Envelope<EnvelopeHeader, EnvelopeBody>;

type Args = ValidInput | Serializable;

type MaybePromise<T> = T | Promise<T>;

/** Blob payloads are not supported; pass ArrayBuffer/typed arrays instead. */
type NoBlob<T> = T extends Blob ? never : T;

/** Task input may be a direct value or native Promise; thenables are plain values. */
type TaskInput = NoBlob<Args> | Promise<NoBlob<Args>>;

/** Per-call timeout. A number is milliseconds; object form can return a default. */
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

type AbortSignalConfig = {
  readonly hasAborted: true;
};

/** `true` or config injects an abort toolkit as the task's second parameter. */
type AbortSignalOption = true | AbortSignalConfig | undefined;

type AbortSignalMethods<AS extends AbortSignalOption> = AS extends undefined
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
  AS extends undefined ? [NoBlob<Awaited<A>>]
    : [NoBlob<Awaited<A>>, AbortSignalToolkit<AS>],
  MaybePromise<NoBlob<B>>
>;

type PromiseWithMaybeReject<T> = Promise<T> & {
  reject: (reason?: unknown) => void;
};

type TaskLike<AS extends AbortSignalOption = AbortSignalOption> =
  & {
    readonly f: (...args: any[]) => any;
  }
  & (
    AS extends undefined ? { readonly abortSignal?: undefined }
      : { readonly abortSignal: AS }
  );

type TaskFunctionLike = (...args: any[]) => any;

type Composed<
  A extends TaskInput = Args,
  B extends Args = Args,
  AS extends AbortSignalOption = undefined,
> =
  & FixPoint<A, B, AS>
  & SecondPart;

type tasks = Record<
  string,
  Composed<any, any, any> | TaskFunctionLike
>;

type ComposedWithKey = Composed<any, any, AbortSignalOption> & { name: string };

type PromiseWrapped<
  F extends (...args: any[]) => any,
  AS extends AbortSignalOption = undefined,
> = (
  ...args: PromisifyCallArgs<F, AS>
) => AS extends undefined ? Promise<Awaited<ReturnType<F>>>
  : PromiseWithMaybeReject<Awaited<ReturnType<F>>>;

type PromiseInput<T> = T | Promise<T>;

type PromisifyArgs<T extends unknown[]> = {
  [K in keyof T]: PromiseInput<T[K]>;
};

type NormalizeUndefinedSingleArg<T extends unknown[]> = T extends [undefined]
  ? [] | [undefined]
  : T;

type AbortAwareCallArgs<T extends unknown[]> = T extends
  [...infer Head, AbortSignalToolkit<any>] ? NormalizeUndefinedSingleArg<Head>
  : NormalizeUndefinedSingleArg<T>;

type HostCallArgs<
  F extends (...args: any[]) => any,
  AS extends AbortSignalOption,
> = AS extends undefined ? Parameters<F>
  : AbortAwareCallArgs<Parameters<F>>;

type PromisifyCallArgs<
  F extends (...args: any[]) => any,
  AS extends AbortSignalOption,
> = HostCallArgs<F, AS> extends infer T ? T extends unknown[] ? PromisifyArgs<T>
  : never
  : never;

type TaskCallable<T> = T extends TaskLike<any> ? T["f"]
  : T extends TaskFunctionLike ? T
  : never;

type AbortSignalOfTask<T> = T extends { readonly abortSignal: infer AS }
  ? Extract<AS, AbortSignalOption>
  : undefined;

type FunctionMapType<
  T extends Record<string, TaskLike<any> | TaskFunctionLike>,
> = {
  [K in keyof T]: PromiseWrapped<
    TaskCallable<T[K]>,
    AbortSignalOfTask<T[K]>
  >;
};

interface FixPointBase<
  A extends TaskInput,
  B extends Args,
  AS extends AbortSignalOption = undefined,
> {
  /** Worker function. It receives one value; use a tuple/object for many inputs. */
  readonly f: TaskFn<A, B, AS>;
  /** Soft call timeout. Use `worker.hardTimeoutMs` for runaway CPU walls. */
  readonly timeout?: TaskTimeout;
}

type FixPoint<
  A extends TaskInput,
  B extends Args,
  AS extends AbortSignalOption = undefined,
> =
  & FixPointBase<A, B, AS>
  & (
    AS extends undefined ? { readonly abortSignal?: undefined }
      : { readonly abortSignal: AS }
  );

type ImportTaskOptions<
  A extends TaskInput = void,
  B extends Args = void,
  AS extends AbortSignalOption = undefined,
> = Omit<FixPoint<A, B, AS>, "f"> & {
  /** Module imported by the worker only. Relative paths resolve from caller. */
  readonly href: string;
  /** Plain function export name. Defaults to `"default"`; do not target `task()`. */
  readonly name?: string;
};

type SecondPart = {
  readonly [endpointSymbol]: true;
  readonly id: number;
  /** Logical export order used to match worker tasks before names are known. */
  readonly at: number;
  readonly importedFrom: string;
  /**
   * Imported tasks stay on worker lanes so imports run under worker permissions.
   */
  readonly imported?: boolean;
};

type SingleTaskPool<
  A extends TaskInput = Args,
  B extends Args = Args,
  AS extends AbortSignalOption = undefined,
> = {
  /** Invoke the single task. Arguments may be native Promises. */
  call: PromiseWrapped<TaskFn<A, B, AS>, AS>;
  /** Await worker teardown now. `using` disposes at scope exit without awaiting. */
  shutdown: (delayMs?: number) => Promise<void>;
  /** Starts shutdown at scope exit. Use `shutdown()` when you must await it. */
  [Symbol.dispose]: () => void;
};

type Pool<T extends Record<string, TaskLike<any> | TaskFunctionLike>> = {
  /** Await worker teardown now. `using` disposes at scope exit without awaiting. */
  shutdown: (delayMs?: number) => Promise<void>;
  /** Starts shutdown at scope exit. Use `shutdown()` when you must await it. */
  [Symbol.dispose]: () => void;
  /**
   * Typed task callers. Each call accepts the task input or a native Promise.
   * Thrown errors/rejections reject here as Error objects with cause chains.
   */
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

/** Debug namespaces for host setup, worker state, imports, globals, and lifecycle. */
type DebugNamespace = "host" | "globals" | "signals" | "imports" | "lifecycle";

type DebugFlags = { [Namespace in DebugNamespace]?: boolean };

/** Pass `true` for all debug, or enable namespaces by name. */
type DebugOptions = boolean | DebugFlags;

type WorkerBootstrapContext = {
  readonly thread: number;
  readonly totalNumberOfThread: number;
  readonly runtime: "node" | "deno" | "bun" | "unknown";
};

type WorkerBootstrapFunction<Data = unknown> = (
  data: Data,
  context: WorkerBootstrapContext,
) => MaybePromise<void>;

type WorkerBootstrapOptions<Data = unknown> = {
  /**
   * Module imported inside the worker before task modules are imported.
   * Relative paths are resolved from the `createPool(...)` caller.
   */
  href: string;
  /**
   * Exported bootstrap function name. Defaults to `"default"`.
   */
  name?: string;
  /**
   * Structured data passed to the bootstrap function.
   */
  data?: Data;
};

type WorkerSettings = {
  resolveAfterFinishingAll?: true;
  /**
   * Privileged async worker hook that runs once before task modules import.
   * Use it to shape the worker environment before user task code loads.
   */
  bootstrap?: WorkerBootstrapOptions;
  /**
   * Experimental worker runtime.
   * "thread" uses Worker/worker_threads. "process" spawns another JavaScript
   * runtime, useful for process isolation, bwrap, and containers.
   */
  runtime?: "thread" | "process";
  /**
   * Runtime executable to use when runtime is "process". Defaults to "deno".
   */
  processRuntime?: "bun" | "deno" | "node";
  /**
   * Command argv to prepend before the process worker runtime command.
   * Useful for wrappers such as systemd-run, cgexec, nice, taskset, or
   * docker. Knitting appends the runtime command after this prefix.
   *
   * Example:
   * ["systemd-run", "--scope", "-p", "MemoryMax=500M", "-p", "CPUQuota=25%"]
   *
   * With containers, use processSharedMemory: "named", share the IPC
   * namespace, mount the worker files at the same path, and forward
   * KNITTING_PROCESS_WORKER plus KNITTING_PROCESS_WORKER_BOOT.
   */
  processCommandPrefix?: string[];
  /**
   * How process workers discover their shared-memory control channel.
   *
   * "inherit" keeps the POSIX fd-inheritance path and is the default outside
   * Windows. "named" creates an OS-named shared-memory object that wrappers
   * such as containers can reopen by name when they share the same IPC
   * namespace.
   */
  processSharedMemory?: ProcessSharedMemoryMode | ProcessSharedMemorySettings;
  timers?: WorkerTimers;
  /**
   * Hard task execution timeout in milliseconds.
   * When exceeded, the pool is force-shutdown to stop runaway CPU tasks.
   */
  hardTimeoutMs?: number;
};

type ProcessSharedMemoryMode = "inherit" | "named";

type ProcessSharedMemorySettings = {
  mode?: ProcessSharedMemoryMode;
  namePrefix?: string;
  unlinkOnShutdown?: boolean;
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
  /**
   * Host dispatcher topology.
   * - `"per-thread"`: each worker owns its dispatcher and macro channel.
   * - `"serial-channel"`: each worker keeps its own dispatcher check state, but
   *   one shared channel runs all lane checks from first to last.
   *
   * Experimental default: `"per-thread"` on Bun or with one worker, otherwise
   * `"serial-channel"` for multi-worker Node/Deno pools. Can also be forced
   * with the `KNITTING_DISPATCHER` env var (`serial-channel` or `per-thread`).
   */
  dispatcher?: "per-thread" | "serial-channel";
};

type CreatePool = {
  /** Number of workers. Default: 1. */
  threads?: number;
  /** Add a host inline lane for regular tasks. Imported tasks still use workers. */
  inliner?: Inliner;
  balancer?: Balancer;
  worker?: WorkerSettings;
  /**
   * Payload transport settings. Default dynamic payload cap is about 8 MiB
   * (`payloadMaxByteLength >> 3`, with a 64 MiB growth cap).
   */
  payload?: PayloadBufferOptions;
  /**
   * Experimental unsafe options.
   */
  unsafe?: UnsafeOptions;
  /**
   * Abort-aware signal pool capacity.
   * Defaults to `258`.
   */
  abortSignalCapacity?: number;
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
   * Runtime permission protocol.
   * Omit to use strict defaults with `allowImport: true`; worker console is
   * quiet unless `permission: { console: true }`.
   *
   * Task code cannot terminate the host: process/Deno exit APIs are blocked.
   * Use `"strict"` (default for object mode) or `"unsafe"`.
   * Accepts object form for fine-grained permission controls.
   */
  permission?: PermissionProtocolInput;
  debug?: DebugOptions;
  source?: string;
};

// NOTE: Explicit export list with `as` keeps JSR type resolution stable,
// especially for curried APIs like `createPool`.
export type {
  AbortSignalConfig as AbortSignalConfig,
  AbortSignalMethods as AbortSignalMethods,
  AbortSignalOption as AbortSignalOption,
  AbortSignalToolkit as AbortSignalToolkit,
  Args as Args,
  Balancer as Balancer,
  BalancerStrategy as BalancerStrategy,
  Composed as Composed,
  ComposedWithKey as ComposedWithKey,
  CreateContext as CreateContext,
  CreatePool as CreatePool,
  DebugNamespace as DebugNamespace,
  DebugOptions as DebugOptions,
  DispatcherSettings as DispatcherSettings,
  Envelope as Envelope,
  EnvelopeBody as EnvelopeBody,
  EnvelopeHeader as EnvelopeHeader,
  External as External,
  FixPoint as FixPoint,
  FunctionMapType as FunctionMapType,
  ImportTaskOptions as ImportTaskOptions,
  Inliner as Inliner,
  LockBuffers as LockBuffers,
  LockBufferTextCompat as LockBufferTextCompat,
  MaybePromise as MaybePromise,
  PayloadBufferMode as PayloadBufferMode,
  PayloadBufferOptions as PayloadBufferOptions,
  PermissionProtocol as PermissionProtocol,
  PermissionProtocolInput as PermissionProtocolInput,
  Pool as Pool,
  ProcessSharedMemoryMode as ProcessSharedMemoryMode,
  ProcessSharedMemorySettings as ProcessSharedMemorySettings,
  ResolvedPermissionProtocol as ResolvedPermissionProtocol,
  ReturnFixed as ReturnFixed,
  SecondPart as SecondPart,
  SharedBufferRegion as SharedBufferRegion,
  SharedBufferSource as SharedBufferSource,
  SharedBufferTextCompat as SharedBufferTextCompat,
  SingleTaskPool as SingleTaskPool,
  TaskFn as TaskFn,
  TaskInput as TaskInput,
  tasks as tasks,
  TaskTimeout as TaskTimeout,
  ValidInput as ValidInput,
  WorkerBootstrapContext as WorkerBootstrapContext,
  WorkerBootstrapFunction as WorkerBootstrapFunction,
  WorkerBootstrapOptions as WorkerBootstrapOptions,
  WorkerCall as WorkerCall,
  WorkerContext as WorkerContext,
  WorkerData as WorkerData,
  WorkerInvoke as WorkerInvoke,
  WorkerSettings as WorkerSettings,
  WorkerTimers as WorkerTimers,
};
export type { Task as Task } from "./memory/lock.ts";
export {
  LockBound as LockBound,
  PayloadBuffer as PayloadBuffer,
  PayloadSignal as PayloadSignal,
  TaskIndex as TaskIndex,
} from "./memory/lock.ts";
export type { RegisterMalloc as RegisterMalloc } from "./memory/regionRegistry.ts";
