import { toModuleUrl } from "./module-url.ts";
import type { NodeCallSiteLike } from "./node-compat.ts";

export const genTaskID = ((counter: number) => () => counter++)(0);

/**
 * Identity of a task, stable across processes.
 *
 * `genTaskID` numbers tasks by the order their module happened to be evaluated,
 * which host and worker do not share: the host imports in its own source order
 * and the worker imports in task-name order. `(href, at)` is the same pair in
 * both, because `at` counts `task()` calls within one module.
 */
export const stableTaskID = (href: string, at: number): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < href.length; index++) {
    hash = Math.imul(hash ^ href.charCodeAt(index), 0x01000193);
  }
  return (Math.imul(hash ^ at, 0x01000193) >>> 0);
};

const INTERNAL_CALLER_HINTS = [
  "/src/common/task-source.ts",
  "/src/common/task-source.js",
  "\\src\\common\\task-source.ts",
  "\\src\\common\\task-source.js",
  "/src/api.ts",
  "/src/api.js",
  "\\src\\api.ts",
  "\\src\\api.js",
];

const INTERNAL_CALLER_FUNCTIONS = new Set([
  "collectStackFrames",
  "resolveCallerHref",
  "getCallerFilePath",
  "buildTaskDefinition",
  "buildTaskDefinitionFromCaller",
  "task",
  "importTask",
]);

type StackFrameInfo = {
  file: string;
  functionName: string | undefined;
  methodName: string | undefined;
};

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

const isInternalCallerFrame = (file: string): boolean =>
  INTERNAL_CALLER_HINTS.some((hint) => file.includes(hint));

const isRuntimeInternalFrame = (file: string): boolean =>
  file.startsWith("node:") ||
  file.startsWith("native:") ||
  file.startsWith("bun:") ||
  file.startsWith("internal/");

const isInternalCallerFunction = (
  functionName: string | undefined,
  methodName: string | undefined,
): boolean =>
  (functionName !== undefined && INTERNAL_CALLER_FUNCTIONS.has(functionName)) ||
  (methodName !== undefined && INTERNAL_CALLER_FUNCTIONS.has(methodName));

const collectStackFrames = (): StackFrameInfo[] => {
  const ErrorCtor = Error as typeof Error & {
    prepareStackTrace?: (error: Error, stack: NodeCallSiteLike[]) => unknown;
  };
  const original = ErrorCtor.prepareStackTrace;

  try {
    ErrorCtor.prepareStackTrace = (_error, stack) => stack;
    const stack = new Error().stack as unknown;
    if (!Array.isArray(stack)) return [];

    const frames = (stack as NodeCallSiteLike[])
      .map((site) => {
        try {
          const file = site?.getFileName?.();
          if (typeof file !== "string" || file.length === 0) return undefined;
          return {
            file,
            functionName: site?.getFunctionName?.() ?? undefined,
            methodName: site?.getMethodName?.() ?? undefined,
          } satisfies StackFrameInfo;
        } catch {
          return undefined;
        }
      })
      .filter(isDefined);

    return frames;
  } finally {
    ErrorCtor.prepareStackTrace = original;
  }
};

const isInternalFrame = (frame: StackFrameInfo): boolean =>
  isRuntimeInternalFrame(frame.file) ||
  isInternalCallerFrame(frame.file) ||
  isInternalCallerFunction(frame.functionName, frame.methodName);

// Module-URL override for runtimes without stack traces (e.g. Andromeda, where
// `new Error().stack` is undefined). When set, caller discovery skips stack
// inspection and attributes every task here. Set via
// `setModuleUrl(import.meta.url)`, which runs in both host and worker copies so
// both agree on the path.
let moduleUrlOverride: string | undefined;

export const setModuleUrl = (url: string | undefined): void => {
  moduleUrlOverride = typeof url === "string" && url.length > 0
    ? toModuleUrl(url)
    : undefined;
};

export const getModuleUrlOverride = (): string | undefined => moduleUrlOverride;

const resolveCallerHref = (offset: number): string => {
  if (moduleUrlOverride !== undefined) return moduleUrlOverride;

  const frames = collectStackFrames();
  const direct = frames[offset];
  const caller = (
    direct && !isInternalFrame(direct)
      ? direct.file
      : undefined
  ) ??
    frames.find((frame) => !isInternalFrame(frame))?.file ??
    frames.find((frame) => !isRuntimeInternalFrame(frame.file))?.file;

  if (!caller) {
    throw new Error(
      "Unable to determine caller file. This runtime exposes no stack traces " +
        "(e.g. Andromeda); call setModuleUrl(import.meta.url) at the top of " +
        "the module that defines your tasks before creating a pool.",
    );
  }

  return toModuleUrl(caller);
};

const linkingMap = new Map<string, number>();

export const getCallerHref = (offset = 3): string => resolveCallerHref(offset);

export const getCallerFilePath = (offset = 3) => {
  const href = resolveCallerHref(offset);
  const at = linkingMap.get(href) ?? 0;
  linkingMap.set(href, at + 1);
  return [href, at] as [string, number];
};
