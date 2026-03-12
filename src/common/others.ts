import { toModuleUrl } from "./module-url.ts";

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
    prepareStackTrace?: (error: Error, stack: NodeJS.CallSite[]) => unknown;
  };
  const original = ErrorCtor.prepareStackTrace;

  try {
    ErrorCtor.prepareStackTrace = (_error, stack) => stack;
    const stack = new Error().stack as unknown;
    if (!Array.isArray(stack)) return [];

    const frames = (stack as NodeJS.CallSite[])
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

const summarizeFrames = (frames: StackFrameInfo[]): string => {
  if (frames.length === 0) return "(no stack frames)";
  return frames
    .slice(0, 6)
    .map((frame, index) => {
      const label = frame.functionName ?? frame.methodName ?? "<anonymous>";
      return `#${index} ${label} @ ${frame.file}`;
    })
    .join(" | ");
};

const resolveCallerHref = (offset: number): string => {
  const frames = collectStackFrames();
  const direct = frames[offset];
  const caller = (
    direct && !isInternalFrame(direct) ? direct.file : undefined
  ) ??
    frames.find((frame) => !isInternalFrame(frame))?.file ??
    frames.find((frame) => !isRuntimeInternalFrame(frame.file))?.file;

  if (!caller) {
    throw new Error(
      `KNT_ERROR_CALLER_RESOLUTION: Unable to determine caller file. ` +
        `offset=${offset}. frames=${summarizeFrames(frames)}`,
    );
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
