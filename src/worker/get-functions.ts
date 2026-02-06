import type { ComposedWithKey, TaskTimeout } from "../types.ts";
import { endpointSymbol } from "../common/task-symbol.ts";

type GetFunctionParams = {
  list: string[];
  ids: number[];
  at: number[];
  isWorker: boolean;
};

type WorkerCallable = (args: unknown) => unknown;

const enum TimeoutKind {
  Reject = 0,
  Resolve = 1,
}

type TimeoutSpec = {
  ms: number;
  kind: TimeoutKind;
  value: unknown;
};

const normalizeTimeout = (timeout?: TaskTimeout): TimeoutSpec | undefined => {
  if (timeout == null) return undefined;
  if (typeof timeout === "number") {
    return timeout >= 0
      ? { ms: timeout, kind: TimeoutKind.Reject, value: new Error("Task timeout") }
      : undefined;
  }
  const ms = timeout.time;
  if (!(ms >= 0)) return undefined;
  if ("default" in timeout) {
    return { ms, kind: TimeoutKind.Resolve, value: timeout.default };
  }
  if (timeout.maybe === true) {
    return { ms, kind: TimeoutKind.Resolve, value: undefined };
  }
  if ("error" in timeout) {
    return { ms, kind: TimeoutKind.Reject, value: timeout.error };
  }
  return { ms, kind: TimeoutKind.Reject, value: new Error("Task timeout") };
};

const raceTimeout = (
  promise: PromiseLike<unknown>,
  spec: TimeoutSpec,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      if (spec.kind === TimeoutKind.Resolve) {
        resolve(spec.value);
      } else {
        reject(spec.value);
      }
    }, spec.ms);

    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });

const isThenable = (value: unknown): value is PromiseLike<unknown> => {
  if (value == null) return false;
  const type = typeof value;
  if (type !== "object" && type !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
};

const composeWorkerCallable = (fixed: ComposedWithKey): WorkerCallable => {
  const fn = fixed.f as (args: unknown) => unknown;
  const timeout = normalizeTimeout(fixed.timeout);
  if (!timeout) return fn;
  return (args: unknown) => {
    const result = fn(args);
    return isThenable(result) ? raceTimeout(result, timeout) : result;
  };
};

export type WorkerComposedWithKey = ComposedWithKey & {
  run: WorkerCallable;
};

export const getFunctions = async (
  { list, ids, at }: GetFunctionParams,
) => {

  const modules = list.map((string) => {
    const url = new URL(string).href;

    if (url.includes("://")) return url;

    return "file://" + new URL(string).href;
  });

  const results = await Promise.all(
    modules.map(async (imports) => {
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
  const flattened = results.flat();
  const useAtFilter = modules.length === 1 && at.length > 0;
  const atSet = useAtFilter ? new Set(at) : null;
  const targetModule = useAtFilter ? modules[0] : null;

  const flattenedResults = flattened
    .filter((obj) =>
      useAtFilter
        ? obj.importedFrom === targetModule && atSet!.has(obj.at)
        : ids.includes(obj.id)
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return flattenedResults.map((fixed) => ({
    ...fixed,
    run: composeWorkerCallable(fixed),
  })) as WorkerComposedWithKey[];
};

export type GetFunctions = ReturnType<typeof getFunctions>;
