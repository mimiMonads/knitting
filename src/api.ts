import { getCallerFilePath } from "./common/others.ts";
import { genTaskID } from "./common/others.ts";
import { spawnWorkerContext } from "./runtime/pool.ts";
import type { PromiseMap } from "./runtime/tx-queue.ts";
import { isMainThread, workerData } from "node:worker_threads";

import { managerMethod } from "./runtime/balancer.ts";
import { createInlineExecutor } from "./runtime/inline-executor.ts";
import type {
  Args,
  ComposedWithKey,
  CreateThreadPool,
  FixedPoints,
  FixPoint,
  FunctionMapType,
  Pool,
  ReturnFixed,
} from "./types.ts";

export const isMain = isMainThread;
export const endpointSymbol = Symbol.for("FIXEDPOINT");

export const fixedPoint = <
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
    list.map(async (imports) => {
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
  args: FixedPoints,
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

export const createThreadPool = ({
  threads,
  debug,
  inliner,
  balancer,
  source,
  worker,
}: CreateThreadPool) =>
<T extends FixedPoints>(fixedPoints: T): Pool<T> => {
  /**
   *  This functions is only available in the main thread.
   *  Also triggers when debug extra is enabled.
   */
  if (isMainThread === false) {
    if ((debug?.extras === true)) {
      console.warn(
        "createThreadPool has been called with : " + JSON.stringify(
          workerData,
        ),
      );
    }
    const uwuError = () => {
      throw new Error(
        "createThreadPool can only be called in the main thread.",
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
      terminateAll: uwu,
      callFunction: uwu,
      fastCallFunction: uwu,
      send: uwu,
    } as Pool<T>);
  }

  const promisesMap: PromiseMap = new Map(),
    { list, ids } = toListAndIds(fixedPoints),
    listOfFunctions = Object.entries(fixedPoints).map(([k, v]) => ({
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
      fixedPoints,
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

  const fastMap = workers
    .map((worker) => {
      return listOfFunctions
        .map((list, index) => ({ ...list, index }))
        .reduce((acc, v) => {
          acc.set(
            v.name,
            worker.fastCalling({
              fnNumber: v.index,
            }),
          );
          return acc;
        }, new Map<string, ReturnType<typeof worker.fastCalling>>());
    })
    .reduce((acc, map) => {
      map.forEach((v, k) => {
        const fun = acc.get(k);
        fun ? acc.set(k, [...fun, v]) : acc.set(k, [v]);
      });
      return acc;
    }, new Map<string, Function[]>());

  const enqueueMap = workers
    .map((worker) => {
      return listOfFunctions
        .map((list, index) => ({ ...list, index }))
        .reduce((acc, v) => {
          acc.set(
            v.name,
            worker.callFunction({
              fnNumber: v.index,
            }),
          );

          return acc;
        }, new Map<string, ReturnType<typeof worker.fastCalling>>());
    })
    .reduce((acc, map) => {
      map.forEach((v, k) => {
        const fun = acc.get(k);
        fun ? acc.set(k, [...fun, v]) : acc.set(k, [v]);
      });
      return acc;
    }, new Map<string, Function[]>());

  const callFunction = new Map<string, (args: any) => Promise<any>>();
  const fastCall = new Map<string, (args: any) => Promise<any>>();

  const runnable = workers.reduce((acc, { send }) => {
    acc.push(send);
    return acc;
  }, [] as (() => void)[]);

  enqueueMap.forEach((v, k) => {
    callFunction.set(
      k,
      (threads === 1 || threads === undefined) && !usingInliner
        ? (v[0] as (args: any) => Promise<any>)
        : managerMethod({
          contexts: workers,
          balancer,
          handlers: v,
        }),
    );
  });

  fastMap.forEach((v, k) => {
    fastCall.set(
      k,
      (threads === 1 || threads === undefined) && !usingInliner
        ? (v[0] as (args: any) => Promise<any>)
        : managerMethod({
          contexts: workers,
          balancer,
          handlers: v,
        }),
    );
  });

  return {
    terminateAll: () => workers.forEach((worker) => worker.kills()),
    callFunction: Object.fromEntries(
      callFunction,
    ) as unknown as FunctionMapType<T>,
    fastCallFunction: Object.fromEntries(
      fastCall,
    ) as unknown as FunctionMapType<T>,
    send: () => runnable.forEach((fn) => fn()),
  } as Pool<T>;
};
