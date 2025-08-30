import { getCallerFilePath } from "./common/others.ts";
import { genTaskID } from "./common/others.ts";
import { spawnWorkerContext } from "./runtime/pool.ts";
import type { PromiseMap } from "./runtime/tx-queue.ts";
import {
  isMainThread,
  type Serializable,
  workerData,
} from "node:worker_threads";

import { type Balancer, managerMethod } from "./runtime/balancer.ts";
import { createInlineExecutor } from "./runtime/inline-executor.ts";

export const isMain = isMainThread;
export type FixedPoints = Record<string, Composed>;

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

export type ValidInput =
  | bigint
  | void
  | JSONValue
  | Map<Serializable, Serializable>
  | Set<Serializable>;

export type External = unknown;

type Args = External | Serializable;

const endpointSymbol = Symbol.for("FIXEDPOINT");

interface FixPoint<A extends Args, B extends Args> {
  readonly href?: string;
  readonly f: (
    args: A,
  ) => Promise<B>;
}

type SecondPart = {
  readonly [endpointSymbol]: string;
  readonly id: number;
  readonly importedFrom: string;
};

export type Composed = {
  readonly f: (...args: any) => any;
} & SecondPart;

export type ComposedWithKey = Composed & { name: string };

type ReturnFixed<A extends Args = undefined, B extends Args = undefined> =
  & FixPoint<A, B>
  & SecondPart;

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
    [endpointSymbol]: "vixeny",
  }) as const;
};

type UnionReturnFixed = ReturnFixed<Args, Args>;

type FunctionMapType<T extends Record<string, FixPoint<Args, Args>>> = {
  [K in keyof T]: T[K]["f"];
};

export type GetFunctions = ReturnType<typeof getFunctions>;

export const getFunctions = async ({ list, ids }: {
  list: string[];
  isWorker: boolean;
  ids: number[];
}) => {
  const results = await Promise.all(
    list.map(async (imports) => {
      //@ts-ignore
      const module = await import(imports);

      return Object.entries(module)
        .filter(
          ([_, value]) =>
            value != null && typeof value === "object" &&
            Object.getOwnPropertySymbols(value).some(
              (sym) => sym === endpointSymbol,
            ),
        )
        .map(([name, value]) => ({
          //@ts-ignore Reason -> trust me
          ...value,
          name,
        })) as ComposedWithKey[];
    }),
  );

  // Flatten the results, filter by IDs, and sort
  const flattenedResults = results
    .flat()
    .filter((obj) => ids.includes(obj.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  return flattenedResults as unknown as (UnionReturnFixed & { name: string })[];
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

export type DebugOptions = {
  extras?: boolean;
  logMain?: boolean;
  //logThreads?: boolean;
  logHref?: boolean;
  logImportedUrl?: boolean;
  threadOrder?: Boolean | number;
};

type Pool<T extends Record<string, FixPoint<Args, Args>>> = {
  terminateAll: { (): void };
  callFunction: FunctionMapType<T>;
  fastCallFunction: FunctionMapType<T>;
  send: { (): void };
};

export type WorkerSettings = {
  resolveAfterFinishinAll?: true;
};

type CreateThreadPool = {
  threads?: number;
  main?: "first" | "last";
  balancer?: Balancer;
  worker?: WorkerSettings;
  debug?: DebugOptions;
  source?: string;
};
export const createThreadPool = ({
  threads,
  debug,
  balancer,
  main,
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

  const totalNumberOfThread = (threads ?? 1) +
    ((typeof main === "string") ? 1 : 0);

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

  if (main) {
    const mainThread = createInlineExecutor({
      fixedPoints,
      genTaskID,
    });

    if (main === "first") {
      workers = [
        //@ts-ignore
        mainThread,
        ...workers,
      ];
    }

    if (main === "last") {
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
      (threads === 1 || threads === undefined) && typeof main !== "string"
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
      (threads === 1 || threads === undefined) && typeof main !== "string"
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
