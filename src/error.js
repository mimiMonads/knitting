import { beginPromisePayload, finishPromisePayload, TaskFlag, TaskIndex, } from "./memory/lock.js";
import { RUNTIME_IS_MAIN_THREAD } from "./common/worker-runtime.js";
export var ErrorKnitting;
(function (ErrorKnitting) {
    ErrorKnitting[ErrorKnitting["Function"] = 0] = "Function";
    ErrorKnitting[ErrorKnitting["Symbol"] = 1] = "Symbol";
    ErrorKnitting[ErrorKnitting["Json"] = 2] = "Json";
    ErrorKnitting[ErrorKnitting["Serializable"] = 3] = "Serializable";
})(ErrorKnitting || (ErrorKnitting = {}));
const reasonFrom = (task, type, detail) => {
    switch (type) {
        case ErrorKnitting.Function: {
            const name = typeof task.value === "function"
                ? (task.value.name || "<anonymous>")
                : "<unknown>";
            return `KNT_ERROR_0: Function is not a valid type; name: ${name}`;
        }
        case ErrorKnitting.Symbol:
            return "KNT_ERROR_1: Symbol must use Symbol.for(...) keys";
        case ErrorKnitting.Json:
            return detail == null || detail.length === 0
                ? "KNT_ERROR_2: JSON stringify failed; payload must be JSON-safe"
                : `KNT_ERROR_2: JSON stringify failed; ${detail}`;
        case ErrorKnitting.Serializable:
            return detail == null || detail.length === 0
                ? "KNT_ERROR_3: Unsupported payload type; serialize it yourself"
                : `KNT_ERROR_3: Unsupported payload type; ${detail}`;
    }
};
export const encoderError = ({ task, type, onPromise, detail, }) => {
    const reason = reasonFrom(task, type, detail);
    if (!RUNTIME_IS_MAIN_THREAD) {
        task.value = reason;
        task[TaskIndex.FlagsToHost] = TaskFlag.Reject;
        return false;
    }
    // Fallback for direct codec usage where no async settle callback is wired.
    if (onPromise == null) {
        throw new TypeError(reason);
    }
    if (!beginPromisePayload(task))
        return false;
    queueMicrotask(() => {
        finishPromisePayload(task);
        task.value = reason;
        onPromise(task, true, reason);
    });
    return false;
};
