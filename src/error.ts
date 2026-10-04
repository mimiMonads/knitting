import {
  beginPromisePayload,
  finishPromisePayload,
  TaskFlag,
  TaskIndex,
  type PromisePayloadHandler,
  type Task,
} from "./memory/lock.ts";
import { RUNTIME_IS_MAIN_THREAD } from "./common/worker-runtime.ts";

// const object, not `enum`: Andromeda's Nova engine can't parse `enum`. Same
// value access and emit on Node/Deno/Bun.
export const ErrorKnitting = {
  Function: 0,
  Symbol: 1,
  Json: 2,
  Serializable: 3,
} as const;
export type ErrorKnitting = typeof ErrorKnitting[keyof typeof ErrorKnitting];

export type KnittingErrorCode =
  | "KNT_ERROR_0"
  | "KNT_ERROR_1"
  | "KNT_ERROR_2"
  | "KNT_ERROR_3"
  | "THREAD_CLOSED"
  | "WORKER_CRASHED"
  | "WORKER_EXITED"
  | "WORKER_STARTUP_FAILED";

/**
 * Rejection raised by Knitting itself rather than by task code. Branch on
 * `code`; `message` keeps the human-readable text.
 */
export class KnittingError extends Error {
  readonly code: KnittingErrorCode;

  constructor(code: KnittingErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "KnittingError";
    this.code = code;
  }
}

const reasonFrom = (
  task: Task,
  type: ErrorKnitting,
  detail?: string,
): string => {
  switch (type) {
    case ErrorKnitting.Function: {
      const name = typeof task.value === "function"
        ? ((task.value as Function).name || "<anonymous>")
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

export const encoderError = ({
  task,
  type,
  onPromise,
  detail,
}: {
  task: Task;
  type: ErrorKnitting;
  onPromise?: PromisePayloadHandler;
  detail?: string;
}): false => {
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

  if (!beginPromisePayload(task)) return false;

  // Built here, not in the microtask, so the stack still names the caller.
  const error = new KnittingError(`KNT_ERROR_${type}`, reason);

  queueMicrotask(() => {
    finishPromisePayload(task);
    task.value = error;
    onPromise(task, true, error);
  });

  return false;
};
