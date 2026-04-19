import type {
  AbortSignalOption,
  ComposedWithKey,
  TaskTimeout,
  WorkerFunctionDescriptor,
} from "../types.ts";
import { getImportedTaskReference } from "../common/import-task.ts";
import { endpointSymbol } from "../common/task-symbol.ts";
import { toModuleUrl } from "../common/module-url.ts";
import type { ResolvedPermissionProtocol } from "../permission/protocol.ts";

type GetFunctionParams = {
  functions: WorkerFunctionDescriptor[];
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

const composeWorkerCallable = (
  fixed: ComposedWithKey,
  _permission?: ResolvedPermissionProtocol,
): Promise<WorkerCallable> | WorkerCallable => {
  const importedTaskReference = getImportedTaskReference(fixed.f);
  if (importedTaskReference) {
    return loadImportedTaskCallable(importedTaskReference);
  }

  return fixed.f as WorkerCallable;
};

export type WorkerComposedWithKey = {
  name: string;
  run: WorkerCallable;
  timeout?: TimeoutSpec;
  abortSignal?: AbortSignalOption;
};

const importedTaskCallableCache = new Map<string, Promise<WorkerCallable>>();
const moduleRecordCache = new Map<string, Promise<Record<string, unknown>>>();

const loadImportedTaskCallable = async (
  { href, name }: { href: string; name: string },
): Promise<WorkerCallable> => {
  const cacheKey = `${href}\u0000${name}`;
  let pending = importedTaskCallableCache.get(cacheKey);

  if (!pending) {
    pending = import(href).then((module) => {
      const record = module as Record<string, unknown>;
      const selected = name === "default" ? record.default : record[name];

      if (typeof selected !== "function") {
        const available = Object.keys(record).join(", ");
        throw new TypeError(
          `importTask expected export "${name}" from "${href}" to be a function.` +
            ` Available exports: ${available || "(none)"}`,
        );
      }

      return selected as WorkerCallable;
    });

    importedTaskCallableCache.set(cacheKey, pending);
  }

  return pending;
};

const loadModuleRecord = async (
  imports: string,
): Promise<Record<string, unknown>> => {
  let pending = moduleRecordCache.get(imports);

  if (!pending) {
    pending = import(imports).then((module) => module as Record<string, unknown>);
    moduleRecordCache.set(imports, pending);
  }

  return pending;
};

const resolveTaskDefinition = (
  descriptor: WorkerFunctionDescriptor,
  imports: string,
  module: Record<string, unknown>,
): ComposedWithKey => {
  const useAtMatch = descriptor.at !== undefined;
  const matched = Object.values(module).find((value) =>
    value != null && typeof value === "object" &&
    //@ts-ignore Reason -> worker verifies endpoint objects at runtime
    value?.[endpointSymbol] === true &&
    (useAtMatch
      ?
      (
        //@ts-ignore Reason -> worker verifies endpoint objects at runtime
        value.importedFrom === imports &&
        //@ts-ignore Reason -> worker verifies endpoint objects at runtime
        value.at === descriptor.at
      ) : (
        descriptor.id === undefined ||
          //@ts-ignore Reason -> worker verifies endpoint objects at runtime
          value.id === descriptor.id
      ))
  );

  if (matched == null || typeof matched !== "object") {
    throw new Error(
      `Worker could not resolve task export "${descriptor.name}" from "${imports}".`,
    );
  }

  return {
    ...(matched as ComposedWithKey),
    name: descriptor.name,
  };
};

const resolvePlainFunctionCallable = (
  descriptor: WorkerFunctionDescriptor,
  imports: string,
  module: Record<string, unknown>,
): WorkerCallable => {
  const primary = descriptor.exportName === "default"
    ? module.default
    : module[descriptor.exportName];
  const fallback = descriptor.exportName === descriptor.name
    ? undefined
    : (descriptor.name === "default" ? module.default : module[descriptor.name]);
  const selected = primary ?? fallback;

  if (typeof selected !== "function") {
    const available = Object.keys(module).join(", ");
    throw new TypeError(
      `Worker expected plain function export "${descriptor.exportName}" from "${imports}".` +
        ` Available exports: ${available || "(none)"}`,
    );
  }

  return selected as WorkerCallable;
};

export const getFunctions = async (
  { functions, permission }: GetFunctionParams,
) => {
  const resolved = await Promise.all(
    functions.map(async (descriptor) => {
      const imports = toModuleUrl(descriptor.importedFrom);
      const module = await loadModuleRecord(imports);

      if (descriptor.kind === "function") {
        return {
          name: descriptor.name,
          run: resolvePlainFunctionCallable(descriptor, imports, module),
        };
      }

      const fixed = resolveTaskDefinition(descriptor, imports, module);
      return {
        name: descriptor.name,
        run: await composeWorkerCallable(fixed, permission),
        timeout: normalizeTimeout(fixed.timeout),
        abortSignal: fixed.abortSignal,
      };
    }),
  );

  return resolved as WorkerComposedWithKey[];
};

export type GetFunctions = ReturnType<typeof getFunctions>;
