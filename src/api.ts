import {
  getCallerFilePath,
  getCallerHref,
  setModuleUrl,
} from "./common/task-source.ts";
import { DEBUG_ENABLED, resolveDebugNamespaces } from "./debug/gate.ts";
import { genTaskID } from "./common/task-source.ts";
import { toModuleUrl } from "./common/module-url.ts";
import { endpointSymbol } from "./common/task-symbol.ts";
import { spawnWorkerContext } from "./runtime/pool.ts";
import { ChannelHandler } from "./runtime/dispatcher.ts";
import { RUNTIME } from "./common/runtime.ts";
import {
  RUNTIME_IS_MAIN_THREAD,
  RUNTIME_POOL_DEPTH,
  RUNTIME_WORKER_DATA,
} from "./common/worker-runtime.ts";
import {
  resolvePermissionProtocol,
  toRuntimePermissionFlags,
} from "./permission/index.ts";
import { getNodeProcess } from "./common/node-compat.ts";

import { managerMethod } from "./runtime/balancer.ts";
import { createInlineExecutor } from "./runtime/inline-executor.ts";
import type {
  AbortSignalConfig,
  AbortSignalOption,
  AbortSignalToolkit,
  Args,
  Composed,
  ComposedWithKey,
  CreateContext,
  CreatePool,
  FixPoint,
  FunctionMapType,
  ImportTaskOptions,
  MaybePromise,
  Pool,
  ReturnFixed,
  SingleTaskPool,
  TaskFn,
  TaskInput,
  tasks,
  TaskTimeout,
  WorkerInvoke,
  WorkerSettings,
} from "./types.ts";

// NOTE: Explicit API typings keep JSR from widening curried signatures.
type ToListAndIds = {
  list: string[];
  ids: number[];
  names: string[];
  at: number[];
};

type ToListAndIdsFn = (args: ComposedWithKey[]) => ToListAndIds;

type CreatePoolFactory = (
  options: CreatePool,
) => <T extends tasks>(tasks: T) => Pool<T>;

type HostDebug = {
  log: (message: string) => void;
};

const hasDebugNamespace = (
  namespaces: ReadonlySet<string>,
  namespace: string,
): boolean => namespaces.has("*") || namespaces.has(namespace);

const createHostDebug = (
  namespaces: ReadonlySet<string>,
): HostDebug | undefined => {
  const enabled = (namespace: string): boolean =>
    hasDebugNamespace(namespaces, namespace);
  if (!enabled("host")) return undefined;

  const base = performance.now();
  const tag = `host·${RUNTIME}`;
  const log = (message: string): void => {
    const elapsed = (performance.now() - base).toFixed(1);
    console.error(`[${tag}·+${elapsed}ms] host: ${message}`);
  };

  return { log };
};

const readHostCwd = (): string | undefined => {
  const denoCwd = (globalThis as typeof globalThis & {
    Deno?: { cwd?: () => string };
  }).Deno?.cwd;
  if (typeof denoCwd === "function") {
    try {
      return denoCwd();
    } catch {
    }
  }

  const nodeProcess = getNodeProcess();
  if (typeof nodeProcess?.cwd === "function") {
    try {
      return nodeProcess.cwd();
    } catch {
      return undefined;
    }
  }

  return undefined;
};

const formatDebugList = (
  values: readonly string[] | undefined,
  empty = "(none)",
): string => values && values.length > 0 ? values.join(",") : empty;

const MAX_FUNCTION_ID = 0xFFFF;
const MAX_FUNCTION_COUNT = MAX_FUNCTION_ID + 1;
const DEFAULT_IMPORT_EXPORT_NAME = "default";

type InferredTaskFunction = (...args: any[]) => MaybePromise<Args>;

type InferredTaskInput<
  F extends InferredTaskFunction,
  AS extends AbortSignalOption,
> = Parameters<F> extends [] ? void
  : AS extends undefined
    ? Parameters<F> extends [infer A] ? A extends TaskInput ? A : never
    : never
  : Parameters<F> extends [infer A] ? A extends TaskInput ? A : never
  : Parameters<F> extends [infer A, AbortSignalToolkit<AS>]
    ? A extends TaskInput ? A : never
  : never;

type InferredTaskOutput<F extends InferredTaskFunction> =
  Awaited<ReturnType<F>> extends infer R
    ? R extends Blob ? never : R extends Args ? R : never
    : never;

type InferredTaskShape<
  F extends InferredTaskFunction,
  AS extends AbortSignalOption,
> = [InferredTaskInput<F, AS>] extends [never] ? never
  : [InferredTaskOutput<F>] extends [never] ? never
  :
    & {
      readonly f: F;
      readonly timeout?: TaskTimeout;
    }
    & (
      AS extends undefined ? { readonly abortSignal?: undefined }
        : { readonly abortSignal: AS }
    );

export const isMain: boolean = RUNTIME_IS_MAIN_THREAD;
export { endpointSymbol as endpointSymbol };
/**
 * Declare the task module's URL for runtimes without stack traces (e.g.
 * Andromeda) that can't auto-discover the caller. Call once at module top
 * level, before defining tasks:
 *
 * ```ts
 * import { setModuleUrl, task } from "knitting";
 * setModuleUrl(import.meta.url);
 * export const add = task({ f: ([a, b]: [number, number]) => a + b });
 * ```
 *
 * Runs in both host and worker (same module re-imported), so both agree on the
 * path. No-op-safe on Node/Deno/Bun, where stack discovery already works.
 */
export { setModuleUrl as setModuleUrl };

/**
 * Reconstructs stable task order from top-level exports before names are bound.
 */
export const toListAndIds: ToListAndIdsFn = (
  args: ComposedWithKey[],
): ToListAndIds => {
  const result = args
    .reduce(
      (acc, v) => (
        acc[0].add(v.importedFrom),
          acc[1].add(v.id),
          acc[2].add(v.at),
          acc[3].push(v.name),
          acc
      ),
      [
        new Set<string>(),
        new Set<number>(),
        new Set<number>(),
        [] as string[],
      ] as [
        Set<string>,
        Set<number>,
        Set<number>,
        string[],
      ],
    );

  return {
    list: [...result[0]],
    ids: [...result[1]],
    at: [...result[2]],
    names: result[3],
  };
};

const resolveImportHref = (href: string, callerHref: string): string => {
  try {
    return new URL(href, callerHref).href;
  } catch {
    return toModuleUrl(href);
  }
};

const resolveWorkerBootstrapSettings = (
  worker: WorkerSettings | undefined,
  callerHref: string,
): WorkerSettings | undefined => {
  const bootstrap = worker?.bootstrap;
  if (bootstrap === undefined) return worker;

  const name = bootstrap.name ?? DEFAULT_IMPORT_EXPORT_NAME;
  if (typeof bootstrap.href !== "string" || bootstrap.href.length === 0) {
    throw new TypeError("worker.bootstrap.href must be a non-empty string");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("worker.bootstrap.name must be a non-empty string");
  }

  return {
    ...worker,
    bootstrap: {
      ...bootstrap,
      href: resolveImportHref(bootstrap.href, callerHref),
      name,
    },
  };
};

const isTaskDefinition = (
  value: unknown,
): value is Composed<any, any, AbortSignalOption> =>
  value != null &&
  typeof value === "object" &&
  typeof (value as { f?: unknown }).f === "function";

const toPoolTaskEntries = <T extends tasks>(
  input: T,
  callerHref: string,
): ComposedWithKey[] =>
  Object.entries(input).map(([name, value]) => {
    if (isTaskDefinition(value)) {
      return {
        ...value,
        name,
      } as ComposedWithKey;
    }

    if (typeof value === "function") {
      return {
        f: value,
        id: -1,
        importedFrom: new URL(callerHref).href,
        at: -1,
        name,
        [endpointSymbol]: true,
      } as ComposedWithKey;
    }

    throw new TypeError(
      `createPool task "${name}" must be a task definition or exported function`,
    );
  });

/**
 * Create a typed worker pool from module-scope exported tasks/functions.
 *
 * Install/import as `knitting` on npm or `@vixeny/knitting` on JSR. Requires
 * Node 22+, Deno 2+, or Bun 1+.
 *
 * Use `createPool(options)({ taskA })`, call `await pool.call.taskA(arg)`, and
 * clean up with `using pool = ...` or `await pool.shutdown()`.
 *
 * Guard host-only pool setup with `isMain`: workers re-import task modules, and
 * top-level imports in those modules run in every worker. Keep task modules
 * lean and separate from server/framework setup. Each task receives one
 * argument; use an object or tuple for multiple values.
 */
export const createPool: CreatePoolFactory = ({
  threads,
  debug,
  inliner,
  balancer,
  payload,
  unsafe,
  abortSignalCapacity,
  source,
  worker,
  workerExecArgv,
  permission,
  host,
}: CreatePool) =>
<T extends tasks>(tasks: T): Pool<T> => {
  const bufferReferenceReturn = unsafe?.BufferReferenceReturn;
  const debugRequested = DEBUG_ENABLED ||
    (debug !== undefined && debug !== false);
  let debugNamespaces: Set<string> | undefined;
  const getDebugNamespaces = (): Set<string> =>
    debugNamespaces ??= resolveDebugNamespaces(debug);
  const hostDebug = debugRequested
    ? createHostDebug(getDebugNamespaces())
    : undefined;
  const debugEnabled = (namespace: string): boolean =>
    debugRequested && hasDebugNamespace(getDebugNamespaces(), namespace);
  /**
   *  This functions is only available in the main thread.
   *  Also triggers when debug extra is enabled.
   */
  if (RUNTIME_IS_MAIN_THREAD === false) {
    if (debugEnabled("lifecycle")) {
      console.warn(
        "createPool has been called with : " + JSON.stringify(
          RUNTIME_WORKER_DATA,
        ),
      );
    }
    const notMainThreadError = () => {
      throw new Error(
        "createPool can only be called in the main thread.",
      );
    };

    const throwingProxyTarget = function () {
      return notMainThreadError();
    };

    const throwingProxyHandler = {
      get: function () {
        return notMainThreadError;
      },
    };

    const mainThreadOnlyProxy = new Proxy(
      throwingProxyTarget,
      throwingProxyHandler,
    );

    //@ts-ignore
    return ({
      shutdown: mainThreadOnlyProxy,
      [Symbol.dispose]: () => {},
      call: mainThreadOnlyProxy,
    } as Pool<T>);
  }

  const callerHref = getCallerHref(3);
  const listOfFunctions = toPoolTaskEntries(tasks, callerHref)
    .sort((a, b) => a.name.localeCompare(b.name));
  const { list, ids, names, at } = toListAndIds(listOfFunctions);

  hostDebug?.log(
    `cwd=${readHostCwd() ?? "(unknown)"} caller=${callerHref}`,
  );
  listOfFunctions.forEach((fn) => {
    hostDebug?.log(
      `task name=${fn.name} id=${fn.id} from=${fn.importedFrom}`,
    );
  });

  if (listOfFunctions.length > MAX_FUNCTION_COUNT) {
    throw new RangeError(
      `Too many tasks: received ${listOfFunctions.length}. ` +
        `Maximum is ${MAX_FUNCTION_COUNT} (Uint16 function IDs: 0..${MAX_FUNCTION_ID}).`,
    );
  }

  const usingInliner = typeof inliner === "object" && inliner != null;
  const totalNumberOfThread = (threads ?? 1) +
    (usingInliner ? 1 : 0);
  const permissionProtocol = resolvePermissionProtocol({
    permission: permission ?? {
      mode: "strict",
      allowImport: true,
    },
    modules: list,
  });
  const permissionExecArgv = toRuntimePermissionFlags(permissionProtocol);
  const nodeProcess = getNodeProcess();

  const allowedFlags = nodeProcess?.allowedNodeEnvironmentFlags ?? null;
  const isNodePermissionFlag = (flag: string): boolean => {
    const key = flag.split("=", 1)[0];
    return key === "--permission" ||
      key === "--experimental-permission" ||
      key === "--allow-fs-read" ||
      key === "--allow-fs-write" ||
      key === "--allow-worker" ||
      key === "--allow-child-process" ||
      key === "--allow-addons" ||
      key === "--allow-wasi";
  };
  const stripNodePermissionFlags = (flags?: string[]) =>
    flags?.filter((flag) => !isNodePermissionFlag(flag));
  const dedupeFlags = (flags: string[]) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const flag of flags) {
      if (seen.has(flag)) continue;
      seen.add(flag);
      out.push(flag);
    }
    return out;
  };
  const sanitizeExecArgv = (flags?: string[]) => {
    if (!flags || flags.length === 0) return undefined;
    if (!allowedFlags) return flags;
    const filtered = flags.filter((flag) => {
      const key = flag.split("=", 1)[0];
      return allowedFlags.has(key);
    });
    return filtered.length > 0 ? filtered : undefined;
  };
  const inheritedExecArgv = Array.isArray(nodeProcess?.execArgv)
    ? nodeProcess.execArgv
    : undefined;
  const defaultExecArgvCandidate = workerExecArgv ??
    (inheritedExecArgv
      ? (
        allowedFlags?.has("--expose-gc") === true
          ? (
            inheritedExecArgv.includes("--expose-gc")
              ? inheritedExecArgv
              : [...inheritedExecArgv, "--expose-gc"]
          )
          : inheritedExecArgv
      )
      : undefined);
  const defaultExecArgv = permissionProtocol?.unsafe === true
    ? stripNodePermissionFlags(defaultExecArgvCandidate)
    : defaultExecArgvCandidate;
  const combinedExecArgv = dedupeFlags([
    ...permissionExecArgv,
    ...(defaultExecArgv ?? []),
  ]);
  const execArgv = sanitizeExecArgv(
    combinedExecArgv.length > 0 ? combinedExecArgv : undefined,
  );

  hostDebug?.log(
    `pool runtime=${RUNTIME} workers=${threads ?? 1}` +
      ` lanes=${totalNumberOfThread} inliner=${usingInliner ? "on" : "off"}`,
  );
  hostDebug?.log(
    `modules=${formatDebugList(list)}`,
  );
  hostDebug?.log(
    `permission=${permissionProtocol?.mode ?? "off"} execArgv=${
      formatDebugList(execArgv)
    }`,
  );

  const usesAbortSignal = listOfFunctions.some((fn) =>
    fn.abortSignal !== undefined
  );
  const resolvedWorker = resolveWorkerBootstrapSettings(
    worker,
    callerHref,
  );
  if (resolvedWorker?.bootstrap !== undefined) {
    hostDebug?.log(
      `bootstrap href=${resolvedWorker.bootstrap.href}` +
        ` name=${resolvedWorker.bootstrap.name}`,
    );
  }
  if (usingInliner && resolvedWorker?.bootstrap !== undefined) {
    throw new Error("worker.bootstrap cannot be used with the inliner");
  }
  const hardTimeoutMs = Number.isFinite(resolvedWorker?.hardTimeoutMs)
    ? Math.max(1, Math.floor(resolvedWorker?.hardTimeoutMs as number))
    : undefined;

  if (RUNTIME_POOL_DEPTH >= 1) {
    throw new Error(
      `createPool() tried to spawn workers from inside a worker process ` +
        `(pool depth ${RUNTIME_POOL_DEPTH}). This usually means a pool is ` +
        `created at module scope in a module your workers import, so every ` +
        `worker spawns its own pool recursively. Is your createPool protected ` +
        `by isMain? Guard pool creation behind \`if (isMain) { ... }\` ` +
        `(import { isMain } from "knitting") so only the main program starts ` +
        `the pool.`,
    );
  }

  const dispatcherEnv = nodeProcess?.env?.KNITTING_DISPATCHER;
  const explicitDispatcher = host?.dispatcher ??
    (
      dispatcherEnv === "serial-channel" || dispatcherEnv === "per-thread"
        ? dispatcherEnv
        : undefined
    );
  const autoDispatcher = (() => {
    // Experimental default for HTTP-style bursts: Bun still favors direct
    // per-thread channels, while Node/Deno multi-worker pools favor one shared
    // macro channel over the per-lane dispatcher checks.
    if (RUNTIME === "bun") return "per-thread";
    if ((threads ?? 1) <= 1) return "per-thread";
    return "serial-channel";
  })();
  const dispatcher = explicitDispatcher ?? autoDispatcher;
  const serialChannel = dispatcher === "serial-channel";
  const serialDispatcherChannel = serialChannel
    ? new ChannelHandler()
    : undefined;

  let workers = Array.from({
    length: threads ?? 1,
  }).map((_, thread) =>
    spawnWorkerContext({
      list,
      ids,
      names,
      at,
      thread,
      debug,
      hostDebug: hostDebug?.log,
      totalNumberOfThread,
      source,
      workerOptions: resolvedWorker,
      workerExecArgv: execArgv,
      host,
      payload,
      bufferReferenceReturn,
      abortSignalCapacity,
      usesAbortSignal,
      permission: permissionProtocol,
      sharedChannelHandler: serialDispatcherChannel,
    })
  );

  const sharedDispatcherChannel = serialDispatcherChannel;
  if (serialChannel) {
    const channel = serialDispatcherChannel!;
    const checks = workers.map((context) => context.dispatcherCheck!);
    let serialScheduled = false;
    let serialInFlight = false;
    let serialRerun = false;

    const runSerialChecks = () => {
      if (serialInFlight) {
        serialRerun = true;
        return;
      }
      serialInFlight = true;

      do {
        serialRerun = false;
        serialScheduled = false;

        for (let index = 0; index < checks.length; index++) {
          const check = checks[index]!;
          if (check.isRunning !== true) check.isRunning = true;
          check();
        }
      } while (serialRerun);

      serialInFlight = false;
    };

    const scheduleSerialCheck = () => {
      if (serialInFlight) {
        serialRerun = true;
        return;
      }
      if (serialScheduled) return;
      serialScheduled = true;
      Promise.resolve().then(runSerialChecks);
    };

    channel.open(runSerialChecks);
    workers.forEach((context) => {
      const wake = context.laneWake!;
      context.bindSend!(() => {
        scheduleSerialCheck();
        wake();
      });
    });
    hostDebug?.log(`dispatcher=serial-channel lanes=${checks.length}`);
  } else {
    hostDebug?.log(`dispatcher=per-thread lanes=${workers.length}`);
  }

  if (usingInliner) {
    const mainThread = createInlineExecutor({
      tasks: listOfFunctions,
      genTaskID,
      batchSize: inliner?.batchSize ?? 1,
    });

    if (inliner?.position === "first") {
      workers = [
        //@ts-ignore
        mainThread,
        ...workers,
      ];
    } else {
      workers.push(
        //@ts-ignore
        mainThread,
      );
    }
  }
  const inlinerIndex = usingInliner
    ? (inliner?.position === "first" ? 0 : workers.length - 1)
    : -1;
  const inlinerDispatchThreshold = Number.isFinite(inliner?.dispatchThreshold)
    ? Math.max(1, Math.floor(inliner?.dispatchThreshold ?? 1))
    : 1;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const closePoolNow = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = Promise.allSettled(workers.map((context) => context.kills()))
      .then(() => {
        sharedDispatcherChannel?.close();
      });
    return closePromise;
  };

  const wrapGuardedInvoke = ({
    invoke,
    taskName,
  }: {
    invoke: WorkerInvoke;
    taskName: string;
  }): WorkerInvoke =>
  (args: Uint8Array) => {
    if (closing) {
      return Promise.reject(new Error("Pool is shut down"));
    }

    const pending = invoke(args);
    if (!hardTimeoutMs) return pending;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `Task hard timeout after ${hardTimeoutMs}ms (${taskName}); pool force-shutdown`,
          ),
        );
        void closePoolNow();
      }, hardTimeoutMs);

      pending.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  };

  const shutdownWithDelay = (delayMs?: number): Promise<void> => {
    if (closePromise) return closePromise;
    if (shutdownPromise) return shutdownPromise;
    const ms = Number.isFinite(delayMs)
      ? Math.max(0, Math.floor(delayMs as number))
      : 0;
    shutdownPromise = (async () => {
      if (closePromise) return await closePromise;
      if (ms > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      }
      if (closePromise) return await closePromise;
      await closePoolNow();
    })();
    return shutdownPromise;
  };
  const disposePool = (): void => {
    void shutdownWithDelay();
  };

  const indexedFunctions = listOfFunctions.map((fn, index) => ({
    name: fn.name,
    index,
    timeout: fn.timeout,
    abortSignal: fn.abortSignal,
    imported: fn.imported === true,
  }));

  const callHandlers = new Map<string, WorkerInvoke[]>();

  for (const { name } of indexedFunctions) {
    callHandlers.set(name, []);
  }

  for (const worker of workers) {
    for (const { name, index, timeout, abortSignal } of indexedFunctions) {
      callHandlers.get(name)!.push(
        wrapGuardedInvoke({
          taskName: name,
          invoke: worker.call({
            fnNumber: index,
            timeout,
            abortSignal,
          }),
        }),
      );
    }
  }

  const useDirectHandler = (threads ?? 1) === 1 && !usingInliner;

  // Imported tasks must never execute on the host inliner lane: their module
  // import is meant to happen inside the worker so worker permission policies
  // apply. When the inliner is active we strip the inline lane from their
  // handler set so they only ever reach real worker lanes.
  const buildImportedInvoker = (handlers: WorkerInvoke[]): WorkerInvoke => {
    const workerHandlers: WorkerInvoke[] = [];
    const workerContexts: CreateContext[] = [];
    for (let lane = 0; lane < handlers.length; lane += 1) {
      if (lane === inlinerIndex) continue;
      workerHandlers.push(handlers[lane]!);
      workerContexts.push(workers[lane]!);
    }

    if (workerHandlers.length === 0) {
      throw new Error(
        "Imported task has no worker lane to run on: the pool only has the " +
          "host inliner. Imported tasks are never inlined on the host; add at " +
          "least one worker thread.",
      );
    }

    if (workerHandlers.length === 1) return workerHandlers[0]!;

    return managerMethod({
      contexts: workerContexts,
      balancer,
      handlers: workerHandlers,
      // No inlinerGate: the inline lane is intentionally excluded here.
    });
  };

  const buildInvoker = (
    handlers: WorkerInvoke[],
    imported: boolean,
  ): WorkerInvoke => {
    if (imported && usingInliner) {
      return buildImportedInvoker(handlers);
    }

    return useDirectHandler ? handlers[0]! : managerMethod({
      contexts: workers,
      balancer,
      handlers,
      inlinerGate: usingInliner
        ? {
          index: inlinerIndex,
          threshold: inlinerDispatchThreshold,
        }
        : undefined,
    });
  };

  let callEntries: Array<readonly [string, WorkerInvoke]>;
  try {
    callEntries = indexedFunctions.map(
      ({ name, imported }) =>
        [name, buildInvoker(callHandlers.get(name)!, imported)] as const,
    );
  } catch (error) {
    // Building invokers can throw (e.g. an imported task with no worker lane,
    // or a balancer that needs >=2 lanes). The inline executor and any spawned
    // workers are already live here, so tear them down before propagating —
    // otherwise their MessageChannel ports / worker handles keep the event
    // loop alive and hang the process.
    void closePoolNow();
    throw error;
  }

  return {
    shutdown: shutdownWithDelay,
    [Symbol.dispose]: disposePool,
    call: Object.fromEntries(callEntries) as unknown as FunctionMapType<T>,
  } as Pool<T>;
};

const SINGLE_TASK_KEY = "__task__";

const createSingleTaskPool = <
  A extends TaskInput,
  B extends Args,
  AS extends AbortSignalOption,
>(
  single: ReturnFixed<A, B, AS>,
  options?: CreatePool,
): SingleTaskPool<A, B, AS> => {
  const pool = createPool(options ?? {})({
    [SINGLE_TASK_KEY]: single,
  } as tasks);

  return {
    call: pool.call[SINGLE_TASK_KEY] as SingleTaskPool<A, B, AS>["call"],
    shutdown: pool.shutdown,
    [Symbol.dispose]: pool[Symbol.dispose],
  };
};

const buildTaskDefinitionFromCaller = <
  A extends TaskInput = void,
  B extends Args = void,
  AS extends true | AbortSignalConfig | undefined = undefined,
>(
  input: FixPoint<A, B, AS>,
  callerHref: string,
  at: number,
  imported = false,
): ReturnFixed<A, B, AS> => {
  const importedFrom = new URL(callerHref).href;

  const out = ({
    ...input,
    id: genTaskID(),
    importedFrom,
    at,
    imported,
    [endpointSymbol]: true,
  }) as ReturnFixed<A, B, AS>;

  out.createPool = (options?: CreatePool) => {
    if (RUNTIME_IS_MAIN_THREAD === false) {
      return out as unknown as SingleTaskPool<A, B, AS>;
    }
    return createSingleTaskPool(out, options);
  };

  return out;
};

const buildTaskDefinition = <
  A extends TaskInput = void,
  B extends Args = void,
  AS extends true | AbortSignalConfig | undefined = undefined,
>(
  input: FixPoint<A, B, AS>,
  callerOffset: number,
): ReturnFixed<A, B, AS> => {
  const [href, at] = getCallerFilePath(callerOffset);
  return buildTaskDefinitionFromCaller(input, href, at);
};

const createImportedTaskFn = <
  A extends TaskInput = void,
  B extends Args = void,
  AS extends true | AbortSignalConfig | undefined = undefined,
>(
  href: string,
  exportName: string,
): TaskFn<A, B, AS> => {
  let cachedFn: ((...args: unknown[]) => unknown) | undefined;
  let cachedLoad: Promise<(...args: unknown[]) => unknown> | undefined;

  const loadFn = async (): Promise<(...args: unknown[]) => unknown> => {
    if (cachedFn) return cachedFn;
    if (!cachedLoad) {
      cachedLoad = import(href).then((module) => {
        const record = module as Record<string, unknown>;
        const selected = exportName === DEFAULT_IMPORT_EXPORT_NAME
          ? record.default
          : record[exportName];
        if (typeof selected !== "function") {
          const available = Object.keys(record).join(", ");
          throw new TypeError(
            `importTask expected export "${exportName}" from "${href}" to be a function.` +
              ` Available exports: ${available || "(none)"}`,
          );
        }
        cachedFn = selected as (...args: unknown[]) => unknown;
        return cachedFn;
      });
    }
    return cachedLoad;
  };

  return (async (...args: unknown[]) => {
    const fn = await loadFn();
    return fn(...args);
  }) as TaskFn<A, B, AS>;
};

/**
 * Define a worker task with options.
 *
 * Pass raw module-scope exported functions to `createPool` directly when you do
 * not need options. Use `task({ f })` for timeouts, abort signals, or the
 * single-task `.createPool()` shorthand.
 *
 * The function receives one argument; use a tuple/object for multiple values.
 * Inputs may be direct values or native Promises, so `request.arrayBuffer()` can
 * be forwarded without awaiting on the host.
 */
export function task<F extends InferredTaskFunction>(
  I: InferredTaskShape<F, undefined>,
): ReturnFixed<
  InferredTaskInput<F, undefined>,
  InferredTaskOutput<F>,
  undefined
>;
export function task<F extends InferredTaskFunction>(
  I: InferredTaskShape<F, true>,
): ReturnFixed<
  InferredTaskInput<F, true>,
  InferredTaskOutput<F>,
  true
>;
export function task<
  AS extends AbortSignalConfig,
  F extends InferredTaskFunction,
>(
  I: InferredTaskShape<F, AS>,
): ReturnFixed<
  InferredTaskInput<F, AS>,
  InferredTaskOutput<F>,
  AS
>;
export function task<A extends TaskInput = void, B extends Args = void>(
  I: FixPoint<A, B, true>,
): ReturnFixed<A, B, true>;
export function task<
  A extends TaskInput = void,
  B extends Args = void,
  AS extends AbortSignalConfig = AbortSignalConfig,
>(
  I: FixPoint<A, B, AS>,
): ReturnFixed<A, B, AS>;
export function task<A extends TaskInput = void, B extends Args = void>(
  I: FixPoint<A, B, undefined>,
): ReturnFixed<A, B, undefined>;
export function task<
  A extends TaskInput = void,
  B extends Args = void,
  AS extends true | AbortSignalConfig | undefined = undefined,
>(
  I: FixPoint<A, B, AS>,
): ReturnFixed<A, B, AS> {
  return buildTaskDefinition(I, 4);
}

/**
 * Define a task whose worker-side code is imported only by workers.
 *
 * Use this for untrusted or security-sensitive code: the host keeps a typed
 * wrapper and does not import/evaluate `href`. The target export must be a
 * plain function, not a `task()` wrapper.
 */
export function importTask<A extends TaskInput = void, B extends Args = void>(
  options: ImportTaskOptions<A, B, true>,
): ReturnFixed<A, B, true>;
export function importTask<
  A extends TaskInput = void,
  B extends Args = void,
  AS extends AbortSignalConfig = AbortSignalConfig,
>(
  options: ImportTaskOptions<A, B, AS>,
): ReturnFixed<A, B, AS>;
export function importTask<A extends TaskInput = void, B extends Args = void>(
  options: ImportTaskOptions<A, B, undefined>,
): ReturnFixed<A, B, undefined>;
export function importTask<
  A extends TaskInput = void,
  B extends Args = void,
  AS extends true | AbortSignalConfig | undefined = undefined,
>(
  options: ImportTaskOptions<A, B, AS>,
): ReturnFixed<A, B, AS> {
  const [callerHref, at] = getCallerFilePath(3);
  const {
    href,
    name = DEFAULT_IMPORT_EXPORT_NAME,
    ...rest
  } = options;
  const resolvedHref = resolveImportHref(href, callerHref);

  return buildTaskDefinitionFromCaller<A, B, AS>(
    {
      ...(rest as unknown as Omit<FixPoint<A, B, AS>, "f">),
      f: createImportedTaskFn<A, B, AS>(resolvedHref, name),
    } as FixPoint<A, B, AS>,
    callerHref,
    at,
    true,
  );
}
