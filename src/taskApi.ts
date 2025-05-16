import { getCallerFilePath } from "./utils.ts";
import { genTaskID } from "./utils.ts";
import { createContext } from "./threadManager.ts";
import type { PromiseMap } from "./mainQueueManager.ts";
import { isMainThread } from "node:worker_threads";

export const isMain = isMainThread;
export type FixedPoints = Record<string, Composed>;

export type Serializable =
  | undefined
  | null
  | boolean
  | number
  | string
  | bigint
  | Date
  | RegExp
  | void
  | ArrayBuffer
  | ArrayBufferView
  | { [key: string]: Serializable }
  | Serializable[]
  | Map<Serializable, Serializable>
  | Set<Serializable>
  | Error;

type Uint8Literral = "uint8";
type VoidLiterral = "void";
type StringLiterral = "string";
type numberArrayLiterral = "number[]";
type SerializableLiterral = "serializable";
export type External =
  | Uint8Literral
  | VoidLiterral
  | StringLiterral
  | numberArrayLiterral
  | SerializableLiterral;
type Args = External | Serializable;

const symbol = Symbol.for("FIXEDPOINT");

interface FixPoint<A extends Args, B extends Args> {
  args?: A;
  return?: B;
  f: (
    args: Arguments<A>,
  ) => Promise<Arguments<B>>;
}

type Arguments<A extends Args> = A extends VoidLiterral ? void
  : A extends StringLiterral ? string
  : A extends undefined ? (Serializable)
  : A extends void ? (Serializable)
  : A extends numberArrayLiterral ? number[]
  : A extends SerializableLiterral ? Serializable
  : A;

type SecondPart = {
  [symbol]: string;
  id: number;
  importedFrom: string;
};

export type Composed = {
  args?: Args;
  return?: Args;
  f: (...args: any) => any;
} & SecondPart;

export type ComposedWithKey = Composed & { name: string };

type ReturnFixed<A extends Args = undefined, B extends Args = undefined> =
  & FixPoint<A, B>
  & SecondPart;

export const fixedPoint = <
  A extends Args = undefined,
  B extends Args = undefined,
>(
  I: FixPoint<A, B>,
  thread?: number,
): ReturnFixed<A, B> => {
  const importedFrom = new URL(getCallerFilePath(2)).href;
  return ({
    ...I,
    id: genTaskID(),
    importedFrom,
    [symbol]: "vixeny",
  });
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

      return Object.entries(module) // Use `Object.entries` to include names
        .filter(
          ([_, value]): //@ts-ignore -> Reason trust me bro
          value is ReturnFixed<any> =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            Object.getOwnPropertySymbols(value).some(
              (sym) => sym === Symbol.for("FIXEDPOINT"),
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
  logMain?: boolean;
  logThreads?: boolean;
  logHref?: boolean;
  logImportedUrl?: boolean;
};

const loopingBetweenThreads = ((index) => {
  return (functions: Function[]) => {
    return (max: number) => {
      return (args: any, thread?: number) => {
        return functions[thread ?? (index = (index + 1) % max)](args);
      };
    };
  };
})(-1);

type Pool<T extends Record<string, FixPoint<Args, Args>>> = {
  terminateAll: { (): void };
  callFunction: FunctionMapType<T>;
  fastCallFunction: FunctionMapType<T>;
  send: { (): void };
};

export const createThreadPool = ({
  threads,
  debug,
}: {
  threads?: number;
  debug?: DebugOptions;
}) =>
<T extends FixedPoints>(fixedPoints: T): Pool<T> => {
  const promisesMap: PromiseMap = new Map();

  const { list, ids } = toListAndIds(fixedPoints);

  const listOfFunctions = Object.entries(fixedPoints).map(([k, v]) => ({
    ...v,
    name: k,
  }))
    .sort((a, b) => a.name.localeCompare(b.name)) as ComposedWithKey[];

  const perf = debug ? performance.now() : undefined;
  const workers = Array.from({
    length: threads ?? 1,
  }).map((_, thread) =>
    createContext({
      promisesMap,
      list,
      ids,
      thread,
      debug,
      listOfFunctions,
      perf,
    })
  );

  const fastMap = workers
    .map((worker) => {
      return listOfFunctions
        .map((list, index) => ({ ...list, index }))
        .reduce((acc, v) => {
          // The "fastCalling" method is presumably very similar to callFunction
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
          // The "fastCalling" method is presumably very similar to callFunction
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
      threads === 1
        ? (v[0] as (args: any) => Promise<any>)
        : loopingBetweenThreads(v)(v.length),
    );
  });

  fastMap.forEach((v, k) => {
    fastCall.set(
      k,
      threads === 1
        ? (v[0] as (args: any) => Promise<any>)
        : loopingBetweenThreads(v)(v.length),
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
