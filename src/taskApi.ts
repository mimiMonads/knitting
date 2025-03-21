import { getCallerFilePath } from "./utils.ts";
import { genTaskID } from "./utils.ts";
import { createContext } from "./threadManager.ts";
import type { PromiseMap } from "./mainQueueManager.ts";
import { isMainThread } from "node:worker_threads";

export const isMain = isMainThread;
type Args = "void" | "uint8";
const symbol = Symbol.for("FIXEDPOINT");

type FixPoint<A extends Args> = {
  args: A;
  f: (
    args: A extends "void" ? void : Uint8Array,
  ) => Promise<Uint8Array>;
};

type SecondPart = {
  [symbol]: string;
  id: number;
  importedFrom: string;
};

type Composed = {
  args: Args;
  f: (...args: any) => any;
} & SecondPart;

type ReturnFixed<A extends Args> = FixPoint<A> & SecondPart;

export const fixedPoint = <A extends Args>(
  I: FixPoint<A>,
): ReturnFixed<A> => {
  const importedFrom = new URL(getCallerFilePath(2)).href;
  return ({
    ...I,
    id: genTaskID(),
    importedFrom,
    [symbol]: "vixeny",
  });
};

type UnionReturnFixed = ReturnFixed<Args>;

type FunctionMapType<T extends Record<string, Composed>> = {
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
        }));
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
  args: Record<string, Composed>,
  filter?: string,
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

  if (filter) {
    console.log(filter);
    result[0].delete(filter);
    console.log(result);
  }

  return Object.fromEntries([
    ["list", [...result[0]]],
    ["ids", [...result[1]]],
  ]) as {
    list: string[];
    ids: number[];
  };
};

const loopingBetweenThreads =
  ((n) => (functions: Function[]) => (max: number) => (args: any) =>
    n < max ? functions[n = 0](args) : functions[++n](args))(0);

  export const createThreadPool = ({
    threads,
  }: {
    threads?: number;
  }) =>
  <T extends Record<string, Composed>>(args: T) => {
    const promisesMap: PromiseMap = new Map();
  
    const { list, ids } = toListAndIds(args);
  
    const listOfFunctions = Object.entries(args).map(([k, v]) => ({
      ...v,
      name: k,
    }))
      .sort((a, b) => a.name.localeCompare(b.name));
  
    const workers = Array.from({
      length: threads ?? 1,
    }).map((_, thread) =>
      createContext({
        promisesMap,
        list,
        ids,
        thread,
      })
    );
  
    // -- BUILD CALLFUNCTION MAP
    const map = workers
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
          }, new Map<string, ReturnType<typeof worker.callFunction>>());
      })
      .reduce((acc, map) => {
        map.forEach((v, k) => {
          const fun = acc.get(k);
          fun ? acc.set(k, [...fun, v]) : acc.set(k, [v]);
        });
        return acc;
      }, new Map<string, Function[]>());
  
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
    const enqueue = new Map<string, (args: any) => Promise<any>>();
  
  
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
      callFunction: Object.fromEntries(callFunction) as unknown as FunctionMapType<T>,
      fastCallFunction: Object.fromEntries(fastCall) as unknown as FunctionMapType<T>,
      send: () => runnable.forEach((fn) => fn()),
    };
  };




