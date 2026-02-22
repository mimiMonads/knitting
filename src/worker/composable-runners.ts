import {
  getTaskFunctionMeta,
  getTaskSlotMeta,
  TASK_SLOT_META_VALUE_MASK,
  type Task,
} from "../memory/lock.ts";
import type { TimeoutSpec } from "./get-functions.ts";

type WorkerJob = (args: unknown) => unknown;
type SlotRunner = (slot: Task) => unknown;
type HasAborted = (signal: number) => boolean;

const ABORT_SIGNAL_META_OFFSET = 1;
const TIMEOUT_KIND_RESOLVE = 1;

const raceTimeout = (
  promise: Promise<unknown>,
  ms: number,
  resolveOnTimeout: boolean,
  timeoutValue: unknown,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      if (resolveOnTimeout) resolve(timeoutValue);
      else reject(timeoutValue);
    }, ms);

    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });

const nowStamp = () =>
  (Math.floor(performance.now()) & TASK_SLOT_META_VALUE_MASK) >>> 0;

const applyTimeoutBudget = (
  promise: Promise<unknown>,
  slot: Task,
  spec: TimeoutSpec,
): Promise<unknown> => {
  const elapsed = (nowStamp() - getTaskSlotMeta(slot)) & TASK_SLOT_META_VALUE_MASK;
  const remaining = spec.ms - elapsed;

  if (!(remaining > 0)) {
    // Prevent late unhandled rejections from the original promise.
    promise.then(() => {}, () => {});
    return spec.kind === TIMEOUT_KIND_RESOLVE
      ? Promise.resolve(spec.value)
      : Promise.reject(spec.value);
  }

  const timeoutMs = Math.max(1, Math.floor(remaining));
  return raceTimeout(
    promise,
    timeoutMs,
    spec.kind === TIMEOUT_KIND_RESOLVE,
    spec.value,
  );
};

const throwIfAborted = (
  slot: Task,
  hasAborted?: HasAborted,
) => {
  if (!hasAborted) return;
  const encodedSignal = getTaskFunctionMeta(slot);
  if (encodedSignal === 0) return;

  const signal = (encodedSignal - ABORT_SIGNAL_META_OFFSET) | 0;
  if (signal < 0) return;

  if (hasAborted(signal)) {
    throw new Error("Task aborted");
  }
};

export const composeWorkerRunner = ({
  job,
  timeout,
  hasAborted,
}: {
  job: WorkerJob;
  timeout?: TimeoutSpec;
  hasAborted?: HasAborted;
}): SlotRunner => {
  if (!timeout) {
    return (slot: Task) => {
      throwIfAborted(slot, hasAborted);
      return job(slot.value);
    };
  }

  return (slot: Task) => {
    throwIfAborted(slot, hasAborted);
    const result = job(slot.value);
    if (!(result instanceof Promise)) return result;
    return applyTimeoutBudget(result, slot, timeout);
  };
};
