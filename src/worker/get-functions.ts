import type { ComposedWithKey, TaskTimeout } from "../types.ts";
import { endpointSymbol } from "../common/task-symbol.ts";
import { toModuleUrl } from "../common/module-url.ts";
import type { ResolvedPermissionProtocol } from "../permission/protocol.ts";
import { createInjectedStrictCallable } from "./safety/strict-import.ts";
import {
  ensureStrictSandboxRuntime,
  loadModuleInSandbox,
  loadInSandbox,
} from "./safety/strict-sandbox.ts";

type GetFunctionParams = {
  list: string[];
  ids: number[];
  at: number[];
  isWorker: boolean;
  permission?: ResolvedPermissionProtocol;
};

type WorkerCallable = (args: unknown, abortToolkit?: unknown) => unknown;

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

const toValueTag = Object.prototype.toString;

const isPromiseAcrossRealms = (value: unknown): value is Promise<unknown> =>
  value instanceof Promise ||
  (
    typeof value === "object" &&
    value !== null &&
    toValueTag.call(value) === "[object Promise]"
  );

const cloneToHostRealm = <T>(value: T): T => {
  const clone = (globalThis as typeof globalThis & {
    structuredClone?: <U>(input: U) => U;
  }).structuredClone;
  if (typeof clone !== "function") return value;
  try {
    return clone(value);
  } catch {
    return value;
  }
};

const wrapSandboxLoadedCallable = (fn: WorkerCallable): WorkerCallable => {
  const wrapped: WorkerCallable = (args: unknown, abortToolkit?: unknown) => {
    const out = fn(args, abortToolkit);
    if (!isPromiseAcrossRealms(out)) {
      return cloneToHostRealm(out);
    }
    return Promise.resolve(out).then(
      (value) => cloneToHostRealm(value),
      (error) => Promise.reject(cloneToHostRealm(error)),
    );
  };

  try {
    Object.defineProperty(wrapped, "name", {
      value: fn.name || "strictSandboxLoadedCallable",
      configurable: true,
    });
  } catch {
  }
  try {
    Object.defineProperty(wrapped, "length", {
      value: fn.length,
      configurable: true,
    });
  } catch {
  }
  try {
    Object.defineProperty(wrapped, "toString", {
      value: () => Function.prototype.toString.call(fn),
      configurable: true,
    });
  } catch {
  }

  return wrapped;
};

const composeWorkerCallable = (
  fixed: ComposedWithKey,
  permission?: ResolvedPermissionProtocol,
  loadedInSandbox?: boolean,
  runtimeKey?: string,
): WorkerCallable => {
  const fn = fixed.f as WorkerCallable;
  if (loadedInSandbox === true) {
    return wrapSandboxLoadedCallable(fn);
  }
  const shouldInjectStrictCaller = permission?.enabled === true &&
    permission.unsafe !== true &&
    permission.mode === "strict" &&
    permission.strict.recursiveScan !== false;
  if (!shouldInjectStrictCaller) return fn;
  const shouldUseStrictSandbox = permission?.strict.sandbox === true;
  if (!shouldUseStrictSandbox) {
    return createInjectedStrictCallable(fn);
  }
  const sandboxRuntime = ensureStrictSandboxRuntime(permission, runtimeKey);
  if (!sandboxRuntime) {
    return createInjectedStrictCallable(fn);
  }
  return loadInSandbox(fn, sandboxRuntime);
};

export type WorkerComposedWithKey = ComposedWithKey & {
  run: WorkerCallable;
  timeout?: TimeoutSpec;
};

export const getFunctions = async (
  { list, ids, at, permission }: GetFunctionParams,
) => {

  const modules = list.map((specifier) => toModuleUrl(specifier));
  const shouldUseStrictSandbox = permission?.enabled === true &&
    permission.unsafe !== true &&
    permission.mode === "strict" &&
    permission.strict.recursiveScan !== false &&
    permission.strict.sandbox === true;

  const results = await Promise.all(
    modules.map(async (imports) => {
      const moduleRuntime = shouldUseStrictSandbox
        ? ensureStrictSandboxRuntime(permission, imports)
        : undefined;
      const loadedModule = moduleRuntime
        ? await loadModuleInSandbox(imports, moduleRuntime)
        : {
          namespace: (await import(imports)) as Record<string, unknown>,
          loadedInSandbox: false,
        };
      const module = loadedModule.namespace;
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
          __knittingLoadedInSandbox: loadedModule.loadedInSandbox,
          __knittingStrictRuntimeKey: imports,
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
    run: composeWorkerCallable(
      fixed,
      permission,
      (fixed as unknown as { __knittingLoadedInSandbox?: boolean }).__knittingLoadedInSandbox === true,
      (fixed as unknown as { __knittingStrictRuntimeKey?: string }).__knittingStrictRuntimeKey,
    ),
    timeout: normalizeTimeout(fixed.timeout),
  })) as WorkerComposedWithKey[];
};

export type GetFunctions = ReturnType<typeof getFunctions>;
