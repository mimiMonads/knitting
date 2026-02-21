import type { ComposedWithKey, TaskTimeout } from "../types.ts";
import { endpointSymbol } from "../common/task-symbol.ts";
import { toModuleUrl } from "../common/module-url.ts";

type GetFunctionParams = {
  list: string[];
  ids: number[];
  at: number[];
  isWorker: boolean;
};

type WorkerCallable = (args: unknown) => unknown;

export const enum TimeoutKind {
  Reject = 0,
  Resolve = 1,
}

export type TimeoutSpec = {
  ms: number;
  kind: TimeoutKind;
  value: unknown;
};

const normalizeTimeout = (timeout?: TaskTimeout): TimeoutSpec | undefined => {
  if (timeout == null) return undefined;
  if (typeof timeout === "number") {
    const ms = Math.floor(timeout);
    return ms >= 0
      ? { ms, kind: TimeoutKind.Reject, value: new Error("Task timeout") }
      : undefined;
  }
  const ms = Math.floor(timeout.time);
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


const composeWorkerCallable = (fixed: ComposedWithKey): WorkerCallable => {
  const fn = fixed.f as (args: unknown) => unknown;
  return fn;
};

export type WorkerComposedWithKey = ComposedWithKey & {
  run: WorkerCallable;
  timeout?: TimeoutSpec;
};

export const getFunctions = async (
  { list, ids, at }: GetFunctionParams,
) => {

  const modules = list.map((specifier) => toModuleUrl(specifier));

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
    timeout: normalizeTimeout(fixed.timeout),
  })) as WorkerComposedWithKey[];
};

export type GetFunctions = ReturnType<typeof getFunctions>;
