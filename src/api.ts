import { getCallerFilePath } from "./common/others.ts";
import { genTaskID } from "./common/others.ts";
import { endpointSymbol } from "./common/task-symbol.ts";
import { spawnWorkerContext } from "./runtime/pool.ts";
import { isMainThread, workerData } from "node:worker_threads";

import { managerMethod } from "./runtime/balancer.ts";
import { createInlineExecutor } from "./runtime/inline-executor.ts";
import type {
  Args,
  ComposedWithKey,
  CreatePool,
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

export const isMain: boolean = isMainThread;
export { endpointSymbol as endpointSymbol };


/**
 *  With this information we can recreate the logical order of
 *  relevant exported functions from a file, also it helps to 
 *  track a task before naming, ` export ` elements have to be decalere
 *  at top level and without branching, we take avantage of this to 
 *  correctlly map them. 
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
  source,
  worker,
  workerExecArgv,
  dispatcher,
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
    const uwuError = () => {
      throw new Error(
        "createPool can only be called in the main thread.",
      );
    };

    const base = function () {
      return uwuError();
    };

    const handler = {
      get: function () {
        return uwuError;
      },
    };

    const uwu = new Proxy(base, handler);

    //@ts-ignore
    return ({
      shutdown: uwu,
      call: uwu,
      fastCall: uwu,
      send: uwu,
    } as Pool<T>);
  }

  const { list, ids  , at } = toListAndIds(tasks),
    listOfFunctions = Object.entries(tasks).map(([k, v]) => ({
      ...v,
      name: k,
    }))
      .sort((a, b) => a.name.localeCompare(b.name)) as ComposedWithKey[];

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
      dispatcher,
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

  const indexedFunctions = listOfFunctions.map((fn, index) => ({
    name: fn.name,
    index,
  }));

  const fastHandlers = new Map<string, WorkerInvoke[]>();
  const callHandlers = new Map<string, WorkerInvoke[]>();

  for (const { name } of indexedFunctions) {
    fastHandlers.set(name, []);
    callHandlers.set(name, []);
  }

  for (const worker of workers) {
    for (const { name, index } of indexedFunctions) {
      fastHandlers.get(name)!.push(
        worker.fastCalling({
          fnNumber: index,
        }),
      );

      callHandlers.get(name)!.push(
        worker.call({
          fnNumber: index,
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
      });

  const callEntries = Array.from(
    callHandlers.entries(),
    ([name, handlers]) => [name, buildInvoker(handlers)],
  );

  const fastEntries = Array.from(
    fastHandlers.entries(),
    ([name, handlers]) => [name, buildInvoker(handlers)],
  );

  const runnable = workers.map((worker) => worker.send);

  return {
    shutdown: () => workers.forEach((worker) => worker.kills()),
    call: Object.fromEntries(callEntries) as unknown as FunctionMapType<T>,
    fastCall: Object.fromEntries(fastEntries) as unknown as FunctionMapType<T>,
    send: () => runnable.forEach((fn) => fn()),
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
    fastCall: pool.fastCall[SINGLE_TASK_KEY] as SingleTaskPool<A, B>["fastCall"],
    send: pool.send,
    shutdown: pool.shutdown,
  };
};

export const task: TaskFactory = <
  A extends TaskInput = void,
  B extends Args = void,
>(
  I: FixPoint<A, B>,
): ReturnFixed<A, B> => {
  const [ href , at] = getCallerFilePath()

  const importedFrom = I?.href ?? new URL(href).href;

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
