import { toModuleUrl } from "./module-url.ts";
import type { NodeCallSiteLike } from "./node-compat.ts";

export const genTaskID = ((counter: number) => () => counter++)(0);

const INTERNAL_CALLER_HINTS = [
  "/src/common/others.ts",
  "\\src\\common\\others.ts",
  "/src/api.ts",
  "\\src\\api.ts",
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

const looksLikeStackFile = (value: string): boolean =>
  value.startsWith("file:") ||
  value.startsWith("http:") ||
  value.startsWith("https:") ||
  value.startsWith("blob:") ||
  value.startsWith("webpack-internal:") ||
  value.startsWith("/") ||
  value.startsWith("\\") ||
  /^[A-Za-z]:[\\/]/.test(value);

const extractStackFile = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  const candidates = [
    trimmed.match(/\((.+?):\d+:\d+\)$/)?.[1],
    trimmed.match(/at (.+?):\d+:\d+$/)?.[1],
    trimmed.match(/^(?:.+@)?(.+?):\d+:\d+$/)?.[1],
  ];
  return candidates.find((value) =>
    typeof value === "string" && looksLikeStackFile(value)
  );
};

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
    if (typeof stack === "string") {
      return stack
        .split("\n")
        .map((line) => {
          const file = extractStackFile(line);
          return file
            ? {
              file,
              functionName: undefined,
              methodName: undefined,
            } satisfies StackFrameInfo
            : undefined;
        })
        .filter(isDefined);
    }
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

const resolveCallerHref = (offset: number): string => {
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
    throw new Error("Unable to determine caller file.");
  }

  return toModuleUrl(caller);
};

const linkingMap = new Map<string, number>();

export const getCallerFilePath = (offset = 3) => {
  const href = resolveCallerHref(offset);
  const at = linkingMap.get(href) ?? 0;
  linkingMap.set(href, at + 1);
  return [href, at] as [string, number];
};
