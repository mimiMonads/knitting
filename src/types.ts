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
  /** Ask the worker to leave its dispatch loop before termination. */
  requestStop?(): Promise<boolean>;
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
  /**
   * Hand large returns to the host as a borrowed region in this lane's payload
   * arena instead of copying them out. See `unsafe.SharedBytes`.
   */
  sharedReturn?: boolean;
  permission?: ResolvedPermissionProtocol;
  /** Whether this host can arm an async completion waiter on the return lock. */
  notifyOnHostPublish?: boolean;
  /** Process-local IPC channel can carry coalesced completion doorbells. */
  processCompletionDoorbell?: boolean;
  /** Process-local Deno callback pointer for waking the host completion pump. */
  denoCompletionDoorbell?: bigint;
  /** Process-local Node uv_async handle for waking the host completion pump. */
  nodeCompletionDoorbell?: bigint;
  /**
   * Work stealing. When present, `lock` is a submit region shared by every
   * worker and this worker claims from it as consumer `consumerId` of
   * `consumers`, rather than owning a private request lane. `returnLock` stays
   * private — the endpoint that claims a task owns its response.
   */
  steal?: {
    consumers: number;
    consumerId: number;
    regionLanes: number;
    /** Region mutual-exclusion discipline; see `DispatcherSettings.stealClaim`. */
    claim?: "dekker" | "cas" | "cas-mask";
  };
};

type UnsafeOptions = {
  /**
   * Whether large returns are handed over as a view into shared memory instead
   * of being copied out on the consumer.
   *
   * Defaults to `true`. Set `false` to take the path out of the picture
   * entirely: `sharedBytes()` degrades to a plain `Uint8Array` and every return
   * is copied, so results stay valid for unbounded time.
   */
  SharedBytes?: boolean;
  /**
   * Whether large *arguments* also travel as a borrowed region, and whether
   * `pool.sharedArgBytes` can hand you one to build them in.
   *
   * Defaults to `false`, and the asymmetry with `SharedBytes` is deliberate. A
   * borrowed return is read by the host as soon as it arrives; a borrowed
   * argument is read by task code, which may hold it across an `await` while
   * later calls recycle the region under it. Turn this on only if your tasks
   * consume their byte arguments before their first suspension point.
   *
   * Needs the shared submit queue (the stealing dispatcher). With a per-worker
   * dispatcher there is no single arena to build into, and `sharedArgBytes`
   * falls back to a plain allocation.
   */
  SharedArgs?: boolean;
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
    now: () => number;
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
  /**
   * A `byteLength` buffer to build a byte argument in, taken from the submit
   * arena so the worker reads it in place instead of copying it out.
   *
   * Uninitialized, like `sharedBytes`: write every byte or pass a subarray of
   * what you wrote. The region is recycled after 32 further large arguments, so
   * the receiving task must finish with it before its first `await`.
   *
   * Returns a plain `Uint8Array` unless `unsafe.SharedArgs` is on and the pool
   * uses the shared submit queue, so it is always safe to call.
   */
  sharedArgBytes: (byteLength: number) => Uint8Array;
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

/** Native worker artifact and on-demand compiler settings. */
type CompiledWorkerOptions = {
  /**
   * Native executable path. Relative paths resolve from the createPool caller.
   * Defaults to the task module path with its extension replaced by `.knt`.
   */
  artifact?: string;
  /**
   * Versioned metadata sidecar. Defaults to `<artifact>.json`.
   */
  manifest?: string;
  /**
   * Build a missing/incompatible artifact, or use `"always"` to rebuild once
   * whenever a pool is created. Defaults to true.
   */
  build?: boolean | "always";
  /**
   * Porffor main executable or checkout. Defaults to PORFFOR_MAIN/PORF, then
   * `porf` on PATH; a pinned compiler is cached locally when none is present.
   */
  compiler?: string;
};

type CompiledWorkerSource =
  | string
  | URL
  | { readonly importedFrom: string };

type CompiledWorkerCheck = {
  /** True only when the executable and compatible manifest both validate. */
  compiled: boolean;
  artifact: string;
  manifest: string;
  reason?: string;
  compiler?: string;
  protocol?: string;
  tasks?: readonly string[];
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
   * runtime, useful for process isolation, bwrap, and containers. "compiled"
   * validates and runs a `.knt` native worker, building it on first use.
   */
  runtime?: "thread" | "process" | "compiled";
  /** Artifact settings used when runtime is "compiled". */
  compiled?: CompiledWorkerOptions;
  /**
   * Runtime executable for process workers. Standalone `"porffor"` selects the
   * compiled backend and rebuilds once per pool; with `runtime: "compiled"` it
   * reuses the validated artifact.
   */
  processRuntime?: "bun" | "deno" | "node" | "porffor";
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
   * How many immediate notify loops before the dispatcher stops re-arming the
   * pump for free.
   *
   * The default depends on what the dispatcher escalates *to*. Polling
   * escalates to a `setTimeout` ladder costing ~1.1ms even at delay 0, so it
   * defaults to 128 — escalating is expensive and the wide window also batches
   * completions. A doorbell escalates to `Atomics.waitAsync` at roughly the
   * price of one hop, so pools that have one default to 1. Pools without a
   * doorbell — Deno with FFI denied, or `doorbell: false` — keep 128.
   *
   * Setting this explicitly opts out of that coupling for every pool shape.
   */
  stallFreeLoops?: number;
  /**
   * Max backoff delay (milliseconds).
   */
  maxBackoffMs?: number;
  /**
   * Replace idle completion polling with an `Atomics.waitAsync` doorbell when
   * the host runtime supports it.
   *
   * Defaults to enabled on Node and Bun at any worker count, where it costs
   * 1.6-3.9x less host CPU per completed call. Under HTTP load, where the host
   * has real work of its own, that converts to +13% to +36% throughput.
   *
   * Turn it off for a pool that oversubscribes its machine. The doorbell only
   * progresses when the host gets scheduled, so once workers occupy every core
   * a wake must preempt one: measured +5% to +12.6% rps while workers+host fit
   * within the cores, -22% to -32% once they do not. That is not gated
   * automatically because the core count cannot be probed portably.
   *
   * Deno uses a `threadSafe` FFI callback instead because its `waitAsync` does
   * not wake an idle event loop. Its default asks for `ffi` permission once;
   * `--allow-ffi` skips that prompt, while denial or `--no-prompt` retains
   * polling. Set this to `false` to avoid the request. It is forced off for
   * process workers, which live in another process and cannot call this
   * process-local callback or ring a host Atomics waiter. Compiled (Porffor)
   * workers never reach this path: they reject `host` outright and use pipes
   * rather than shared memory.
   */
  doorbell?: boolean;
  /**
   * Experimental Node native callback bridge for thread workers.
   *
   * Node uses a `uv_async_t` addon to wake the host from the worker thread,
   * removing the JS pump hop. Measured against `Atomics.waitAsync` on a
   * per-thread pool it is throughput-neutral and costs about 20% less host CPU
   * per call on long tasks, while short calls are a wash, so it stays opt-in
   * until it is measured under real host I/O. Bun and Deno ignore this flag:
   * Bun keeps `Atomics.waitAsync`, and Deno's FFI callback remains its default
   * because it fixes an otherwise-idle event loop that `waitAsync` cannot
   * wake.
   */
  nativeDoorbell?: boolean;
  /**
   * Host dispatcher topology.
   * - `"per-thread"`: each worker owns its dispatcher and macro channel.
   * - `"serial-channel"`: each worker keeps its own dispatcher check state, but
   *   one shared channel runs all lane checks from first to last.
   *
   * Used by private-lane pools. Its experimental default is `"per-thread"` on
   * Bun or with one worker, otherwise `"serial-channel"` for multi-worker
   * Node/Deno pools. Selecting it explicitly keeps private lanes unless
   * `steal: true` is also explicit. Can also be forced with the
   * `KNITTING_DISPATCHER` env var (`serial-channel` or `per-thread`).
   */
  dispatcher?: "per-thread" | "serial-channel";
  /**
   * Work stealing: one shared submit region that any worker may
   * claim from, private return lanes, and a pool-global pending registry. The
   * endpoint that claims a task owns its response.
   *
   * Enabled by default for compatible multi-worker thread and process pools
   * unless a balancer or private-lane dispatcher was explicitly selected.
   * One-worker pools, inliners, compiled/Porffor workers, and pools above the
   * current 31-claimant protocol limit retain their existing transport. Set
   * `false` (or `KNITTING_STEAL=0`) to opt out; `KNITTING_STEAL=1` explicitly
   * opts in and overrides a balancer/dispatcher selection.
   */
  steal?: boolean;
  /**
   * Lanes claimed per stealing handshake (a power of two, `slots / g >=
   * workers + 1`). Defaults to the widest region the lane budget allows, which
   * amortises arbitration best for cheap tasks.
   *
   * That bound is a `dekker` liveness requirement, so `stealClaim: "cas"`
   * accepts wider regions — but measured, going more than one notch past it
   * costs 31-49%: with fewer regions than workers, the losers spin on owned
   * sentinels. Keep `slots / g >= workers`.
   *
   * **A region is a batch.** For expensive tasks, a wide region lets one worker
   * claim work the others could have run in parallel; set this to `1` (or a
   * small value) when per-task cost dominates arbitration cost.
   */
  stealRegionLanes?: number;
  /**
   * Region mutual-exclusion discipline for stealing consumers. Experimental.
   *
   * - `"dekker"` (default): the paper protocol. Every consumer owns an intent
   *   word, no word has two writers, and a claim surveys live peers -- O(N)
   *   atomic loads per claim.
   * - `"cas"`: one shared owner mask claimed with `compareExchange`. The claim
   *   cost stops growing with worker count, at the price of one contended
   *   cache line.
   *
   * Can also be forced with the `KNITTING_STEAL_CLAIM` env var.
   */
  stealClaim?: "dekker" | "cas" | "cas-mask";
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
  CompiledWorkerCheck as CompiledWorkerCheck,
  CompiledWorkerOptions as CompiledWorkerOptions,
  CompiledWorkerSource as CompiledWorkerSource,
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
// A value re-export and a type-only re-export from the *same* module in one file
// makes Andromeda's Nova engine panic. Re-export values below, and surface the
// `Task` type via an `import type` alias instead.
import type { Task as TaskType } from "./memory/lock.ts";
export {
  LockBound as LockBound,
  PayloadBuffer as PayloadBuffer,
  PayloadSignal as PayloadSignal,
  TaskIndex as TaskIndex,
} from "./memory/lock.ts";
export type Task = TaskType;
export type { RegisterMalloc as RegisterMalloc } from "./memory/regionRegistry.ts";
