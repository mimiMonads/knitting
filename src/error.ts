import { isMainThread } from "worker_threads";
import { TaskFlag, TaskIndex, type PromisePayloadHandler, type Task } from "./memory/lock.ts";
const promisePayloadMarker = Symbol.for("knitting.promise.payload");

export enum ErrorKnitting {
  Function = 0,
  Symbol = 1,
  Json = 2,
  Serializable = 3,
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
        ? "KNT_ERROR_3: Value is not serializable by v8 serializer"
        : `KNT_ERROR_3: Value is not serializable by v8 serializer; ${detail}`;
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

  if(!isMainThread){
    task.value = reason;
    task[TaskIndex.FlagsToHost] = TaskFlag.Reject 
    return false
  }
 


  // Fallback for direct codec usage where no async settle callback is wired.
  if (onPromise == null) {
    throw new TypeError(reason);
  }

  const markedTask = task as Task & { [promisePayloadMarker]?: boolean };
  if (markedTask[promisePayloadMarker] === true) return false;
  markedTask[promisePayloadMarker] = true;

  queueMicrotask(() => {
    markedTask[promisePayloadMarker] = false;
    task.value = reason;
    onPromise(task, { status: "rejected", reason });
  });

  return false;
};
