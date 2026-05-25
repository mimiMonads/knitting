import { toModuleUrl } from "./module-url.js";
export const genTaskID = ((counter) => () => counter++)(0);
const INTERNAL_CALLER_HINTS = [
    "/src/common/task-source.ts",
    "\\src\\common\\task-source.ts",
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
const isDefined = (value) => value !== undefined;
const isInternalCallerFrame = (file) => INTERNAL_CALLER_HINTS.some((hint) => file.includes(hint));
const isRuntimeInternalFrame = (file) => file.startsWith("node:") ||
    file.startsWith("native:") ||
    file.startsWith("bun:") ||
    file.startsWith("internal/");
const isInternalCallerFunction = (functionName, methodName) => (functionName !== undefined && INTERNAL_CALLER_FUNCTIONS.has(functionName)) ||
    (methodName !== undefined && INTERNAL_CALLER_FUNCTIONS.has(methodName));
const collectStackFrames = () => {
    const ErrorCtor = Error;
    const original = ErrorCtor.prepareStackTrace;
    try {
        ErrorCtor.prepareStackTrace = (_error, stack) => stack;
        const stack = new Error().stack;
        if (!Array.isArray(stack))
            return [];
        const frames = stack
            .map((site) => {
            try {
                const file = site?.getFileName?.();
                if (typeof file !== "string" || file.length === 0)
                    return undefined;
                return {
                    file,
                    functionName: site?.getFunctionName?.() ?? undefined,
                    methodName: site?.getMethodName?.() ?? undefined,
                };
            }
            catch {
                return undefined;
            }
        })
            .filter(isDefined);
        return frames;
    }
    finally {
        ErrorCtor.prepareStackTrace = original;
    }
};
const isInternalFrame = (frame) => isRuntimeInternalFrame(frame.file) ||
    isInternalCallerFrame(frame.file) ||
    isInternalCallerFunction(frame.functionName, frame.methodName);
const resolveCallerHref = (offset) => {
    const frames = collectStackFrames();
    const direct = frames[offset];
    const caller = (direct && !isInternalFrame(direct)
        ? direct.file
        : undefined) ??
        frames.find((frame) => !isInternalFrame(frame))?.file ??
        frames.find((frame) => !isRuntimeInternalFrame(frame.file))?.file;
    if (!caller) {
        throw new Error("Unable to determine caller file.");
    }
    return toModuleUrl(caller);
};
const linkingMap = new Map();
export const getCallerFilePath = (offset = 3) => {
    const href = resolveCallerHref(offset);
    const at = linkingMap.get(href) ?? 0;
    linkingMap.set(href, at + 1);
    return [href, at];
};
