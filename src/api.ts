import { getCallerFilePath } from "./common/others.ts";
import { genTaskID } from "./common/others.ts";
import { toModuleUrl } from "./common/module-url.ts";
import { endpointSymbol } from "./common/task-symbol.ts";
import { spawnWorkerContext } from "./runtime/pool.ts";
import { isMainThread, workerData } from "node:worker_threads";

import { managerMethod } from "./runtime/balancer.ts";
import { createInlineExecutor } from "./runtime/inline-executor.ts";
import type {
  Args,
  ComposedWithKey,
  CreatePool,
  DispatcherOptions,
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

type TaskFactory = <
  A extends TaskInput = void,
  B extends Args = void,
>(
  I: FixPoint<A, B>,
) => ReturnFixed<A, B>;

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
  payloadInitialBytes,
  payloadMaxBytes,
  source,
  worker,
  workerExecArgv,
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

  const allowedFlags = typeof process !== "undefined" &&
      process.allowedNodeEnvironmentFlags
    ? process.allowedNodeEnvironmentFlags
    : null;
  const sanitizeExecArgv = (flags?: string[]) => {
    if (!flags || flags.length === 0) return undefined;
    if (!allowedFlags) return flags;
    const filtered = flags.filter((flag) => {
      const key = flag.split("=", 1)[0];
      return allowedFlags.has(key);
    });
    return filtered.length > 0 ? filtered : undefined;
  };
  const defaultExecArgv = workerExecArgv ??
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
  const execArgv = sanitizeExecArgv(defaultExecArgv);

  const isDispatcherOptions = (
    value: DispatcherOptions | DispatcherSettings | undefined,
  ): value is DispatcherOptions =>
    typeof value === "object" && value !== null && "host" in value;

  const hostDispatcher: DispatcherSettings | undefined = host ??
    (isDispatcherOptions(dispatcher) ? dispatcher.host : dispatcher);
  const usesAbortSignal = listOfFunctions.some((fn) => fn.abortSignal === true);

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
      payloadInitialBytes,
      payloadMaxBytes,
      usesAbortSignal,
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
        worker.call({
          fnNumber: index,
          timeout,
          abortSignal,
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
    shutdown: async () => {
      await Promise.allSettled(workers.map((worker) => worker.kills()));
    },
    call: Object.fromEntries(callEntries) as unknown as FunctionMapType<T>,
  } as Pool<T>;
};

const SINGLE_TASK_KEY = "__task__";

const createSingleTaskPool = <A extends TaskInput, B extends Args>(
  single: ReturnFixed<A, B>,
  options?: CreatePool,
): SingleTaskPool<A, B> => {
  const pool = createPool(options ?? {})({
    [SINGLE_TASK_KEY]: single,
  } as tasks);

  return {
    call: pool.call[SINGLE_TASK_KEY] as SingleTaskPool<A, B>["call"],
    shutdown: pool.shutdown,
  };
};

/**
 * Define a worker task.
 *
 * Input may be a direct value or a native Promise of that value.
 * Thenables/PromiseLike values are treated as plain values.
 */
export const task: TaskFactory = <
  A extends TaskInput = void,
  B extends Args = void,
>(
  I: FixPoint<A, B>,
): ReturnFixed<A, B> => {
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
  }) as ReturnFixed<A, B>;

  out.createPool = (options?: CreatePool) => {
    if (isMainThread === false) {
      return out as unknown as SingleTaskPool<A, B>;
    }
    return createSingleTaskPool(out, options);
  };

  return out;
};
