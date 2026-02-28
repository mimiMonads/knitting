import { getCallerFilePath } from "./common/others.ts";
import { genTaskID } from "./common/others.ts";
import { toModuleUrl } from "./common/module-url.ts";
import { endpointSymbol } from "./common/task-symbol.ts";
import { spawnWorkerContext } from "./runtime/pool.ts";
import { isMainThread, workerData } from "node:worker_threads";
import {
  resolvePermissionProtocol,
  toRuntimePermissionFlags,
} from "./permission/index.ts";

import { managerMethod } from "./runtime/balancer.ts";
import { createInlineExecutor } from "./runtime/inline-executor.ts";
import type {
  Args,
  AbortSignalConfig,
  AbortSignalOption,
  ComposedWithKey,
  CreatePool,
  DispatcherSettings,
  FixPoint,
  FunctionMapType,
  Pool,
  TaskInput,
  SingleTaskPool,
  ReturnFixed,
  WorkerInvoke,
  tasks,
} from "./types.ts";

// NOTE: Explicit API typings keep JSR from widening curried signatures.
type ToListAndIds = {
  list: string[];
  ids: number[];
  at: number[];
};

type ToListAndIdsFn = (args: tasks) => ToListAndIds;

type CreatePoolFactory = (
  options: CreatePool,
) => <T extends tasks>(tasks: T) => Pool<T>;

const MAX_FUNCTION_ID = 0xFFFF;
const MAX_FUNCTION_COUNT = MAX_FUNCTION_ID + 1;

export const isMain: boolean = isMainThread;
export { endpointSymbol as endpointSymbol };


/**
 *  With this information we can recreate the logical order of
 *  relevant exported functions from a file, also it helps to 
 *  track a task before naming, ` export ` elements have to be declared
 *  at top level and without branching, we take advantage of this to 
 *  correctly map them. 
 * 
 */
export const toListAndIds: ToListAndIdsFn = (
  args: tasks,
): ToListAndIds => {
  const result = Object.values(args)
    .reduce(
      (acc, v) => (
        acc[0].add(v.importedFrom), 
        acc[1].add(v.id), 
        acc[2].add(v.at), 
        acc
      ),
      [
        new Set<string>(),
        new Set<number>(),
        new Set<number>()
      ] as [
        Set<string>,
        Set<number>,
        Set<number>,
      ],
    );

  return {
    list: [...result[0]],
    ids: [...result[1]],
    at: [...result[2]],
  };
};

export const createPool: CreatePoolFactory = ({
  threads,
  debug,
  inliner,
  balancer,
  payload,
  payloadInitialBytes,
  payloadMaxBytes,
  bufferMode,
  maxPayloadBytes,
  abortSignalCapacity,
  source,
  worker,
  workerExecArgv,
  permission,
  dispatcher,
  host,
}: CreatePool) =>
<T extends tasks>(tasks: T): Pool<T> => {
  /**
   *  This functions is only available in the main thread.
   *  Also triggers when debug extra is enabled.
   */
  if (isMainThread === false) {
    if ((debug?.extras === true)) {
      console.warn(
        "createPool has been called with : " + JSON.stringify(
          workerData,
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
      call: mainThreadOnlyProxy,
    } as Pool<T>);
  }

  const { list, ids  , at } = toListAndIds(tasks),
    listOfFunctions = Object.entries(tasks).map(([k, v]) => ({
      ...v,
      name: k,
    }))
      .sort((a, b) => a.name.localeCompare(b.name)) as ComposedWithKey[];

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
    permission,
    modules: list,
  });
  const permissionExecArgv = toRuntimePermissionFlags(permissionProtocol);

  const allowedFlags = typeof process !== "undefined" &&
      process.allowedNodeEnvironmentFlags
    ? process.allowedNodeEnvironmentFlags
    : null;
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
  const defaultExecArgvCandidate = workerExecArgv ??
    (typeof process !== "undefined" && Array.isArray(process.execArgv)
      ? (
        allowedFlags?.has("--expose-gc") === true
          ? (
            process.execArgv.includes("--expose-gc")
              ? process.execArgv
              : [...process.execArgv, "--expose-gc"]
          )
          : process.execArgv
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

  const hostDispatcher: DispatcherSettings | undefined = host ?? dispatcher;
  const usesAbortSignal = listOfFunctions.some((fn) => fn.abortSignal !== undefined);
  const hardTimeoutMs = Number.isFinite(worker?.hardTimeoutMs)
    ? Math.max(1, Math.floor(worker?.hardTimeoutMs as number))
    : undefined;

  let workers = Array.from({
    length: threads ?? 1,
  }).map((_, thread) =>
    spawnWorkerContext({
      list,
      ids,
      at,
      thread,
      debug,
      totalNumberOfThread,
      source,
      workerOptions: worker,
      workerExecArgv: execArgv,
      host: hostDispatcher,
      payload,
      payloadInitialBytes,
      payloadMaxBytes,
      bufferMode,
      maxPayloadBytes,
      abortSignalCapacity,
      usesAbortSignal,
      permission: permissionProtocol,
    })
  );

  if (usingInliner) {
    const mainThread = createInlineExecutor({
      tasks,
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
      .then(() => undefined);
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

  const indexedFunctions = listOfFunctions.map((fn, index) => ({
    name: fn.name,
    index,
    timeout: fn.timeout,
    abortSignal: fn.abortSignal,
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

  const buildInvoker = (handlers: WorkerInvoke[]) =>
    useDirectHandler
      ? handlers[0]!
      : managerMethod({
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

  const callEntries = Array.from(
    callHandlers.entries(),
    ([name, handlers]) => [name, buildInvoker(handlers)],
  );

  return {
    shutdown: shutdownWithDelay,
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
  };
};

/**
 * Define a worker task.
 *
 * Input may be a direct value or a native Promise of that value.
 * Thenables/PromiseLike values are treated as plain values.
 */
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
  const [ href , at] = getCallerFilePath()

  const importedFrom = I?.href != null
    ? toModuleUrl(I.href)
    : new URL(href).href;

  const out = ({
    ...I,
    id: genTaskID(),
    importedFrom,
    at,
    [endpointSymbol]: true,
  }) as ReturnFixed<A, B, AS>;

  out.createPool = (options?: CreatePool) => {
    if (isMainThread === false) {
      return out as unknown as SingleTaskPool<A, B, AS>;
    }
    return createSingleTaskPool(out, options);
  };

  return out;
}
