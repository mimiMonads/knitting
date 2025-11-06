import { getCallerFilePath } from "./common/others.ts";
import { genTaskID } from "./common/others.ts";
import { spawnWorkerContext } from "./runtime/pool.ts";
import type { PromiseMap } from "./types.ts";
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
  ReturnFixed,
  WorkerInvoke,
  tasks,
} from "./types.ts";

export const isMain = isMainThread;
export const endpointSymbol = Symbol.for("task");

export const task = <
  A extends Args = void,
  B extends Args = void,
>(
  I: FixPoint<A, B>,
): ReturnFixed<A, B> => {
  const importedFrom = I?.href ?? new URL(getCallerFilePath()).href;

  return ({
    ...I,
    id: genTaskID(),
    importedFrom,
    [endpointSymbol]: true,
  }) as const;
};

export type GetFunctions = ReturnType<typeof getFunctions>;

export const getFunctions = async ({ list, ids }: {
  list: string[];
  isWorker: boolean;
  ids: number[];
}) => {
  const results = await Promise.all(
    list
      //
      .map((string) => {
        const url = new URL(string).href;

        if (url.includes("://")) return url;

        return "file://" + new URL(string).href;
      })
      .map(async (imports) => {
        console;
        const module = await import(imports);
        return Object.entries(module)
          .filter(
            ([_, value]) =>
              value != null && typeof value === "object" &&
              //@ts-ignore Reason -> trust me
              value?.[endpointSymbol] === true,
          )
          .map(([name, value]) => ({
            //@ts-ignore Reason -> trust me
            ...value,
            name,
          })) as unknown as ComposedWithKey[];
      }),
  );

  // Flatten the results, filter by IDs, and sort
  const flattenedResults = results
    .flat()
    .filter((obj) => ids.includes(obj.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  return flattenedResults as unknown as (ReturnFixed<Args, Args> & {
    name: string;
  })[];
};

export const toListAndIds = (
  args: tasks,
) => {
  const result = Object.values(args)
    .reduce(
      (acc, v) => (
        acc[0].add(v.importedFrom), acc[1].add(v.id), acc
      ),
      [
        new Set<string>(),
        new Set<number>(),
      ] as [
        Set<string>,
        Set<number>,
      ],
    );

  return Object.fromEntries([
    ["list", [...result[0]]],
    ["ids", [...result[1]]],
  ]) as {
    list: string[];
    ids: number[];
  };
};

export const createPool = ({
  threads,
  debug,
  inliner,
  balancer,
  source,
  worker,
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

  const promisesMap: PromiseMap = new Map(),
    { list, ids } = toListAndIds(tasks),
    listOfFunctions = Object.entries(tasks).map(([k, v]) => ({
      ...v,
      name: k,
    }))
      .sort((a, b) => a.name.localeCompare(b.name)) as ComposedWithKey[];

  const perf = debug ? performance.now() : undefined;

  const usingInliner = typeof inliner === "object" && inliner != null;
  const totalNumberOfThread = (threads ?? 1) +
    (usingInliner ? 1 : 0);

  let workers = Array.from({
    length: threads ?? 1,
  }).map((_, thread) =>
    spawnWorkerContext({
      promisesMap,
      list,
      ids,
      thread,
      debug,
      listOfFunctions,
      perf,
      totalNumberOfThread,
      source,
      workerOptions: worker,
    })
  );

  if (usingInliner) {
    const mainThread = createInlineExecutor({
      tasks,
      genTaskID,
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
