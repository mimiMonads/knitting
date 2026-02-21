import RingQueue from "../ipc/tools/RingQueue.ts";
import {
  TaskFlag,
  TaskIndex,
  TASK_SLOT_META_VALUE_MASK,
  getTaskSlotMeta,
  type Task,
  type Lock2,
} from "../memory/lock.ts";
import type { WorkerComposedWithKey } from "./get-functions.ts";
import type {
  WorkerSettings,
} from "../types.ts";

type ArgumentsForCreateWorkerQueue = {
  listOfFunctions: WorkerComposedWithKey[];
  workerOptions?: WorkerSettings;
  lock: Lock2;
  returnLock: Lock2;
};

export type CreateWorkerRxQueue = ReturnType<typeof createWorkerRxQueue>;
// Create and manage a working queue.
export const createWorkerRxQueue = (
  {
    listOfFunctions,
    workerOptions,
    lock,
    returnLock,
  }: ArgumentsForCreateWorkerQueue,
) => {
  const PLACE_HOLDER = (_?: unknown) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
  };

  let hasAnythingFinished = 0;
  let awaiting = 0;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.run), acc
  ), [] as Array<(args: unknown) => unknown>);

  const toWork = new RingQueue<Task>();
  const pendingFrames = new RingQueue<Task>();

  const toWorkPush = (slot: Task) => toWork.push(slot);
  const toWorkShift = () => toWork.shiftNoClear();
  const pendingShift = () => pendingFrames.shiftNoClear();
  const pendingUnshift = (slot: Task) => pendingFrames.unshift(slot);
  const pendingPush = (slot: Task) => pendingFrames.push(slot);
  const recyclePush = (slot: Task) => lock.recyclecList.push(slot);
  const IDX_FLAGS = TaskIndex.FlagsToHost;
  const IDX_FN = TaskIndex.FunctionID;
  const FLAG_REJECT = TaskFlag.Reject;
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
    spec: NonNullable<WorkerComposedWithKey["timeout"]>,
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

    // Keep timer strictly positive after subtracting queue wait.
    const timeoutMs = Math.max(1, Math.floor(remaining));
    return raceTimeout(
      promise,
      timeoutMs,
      spec.kind === TIMEOUT_KIND_RESOLVE,
      spec.value,
    );
  };

  const composePlainRunner = (job: (args: unknown) => unknown) =>
    (slot: Task) => job(slot.value);

  const composeTimedRunner = (
    job: (args: unknown) => unknown,
    spec: NonNullable<WorkerComposedWithKey["timeout"]>,
  ) => {
    return (slot: Task) => {
      const result = job(slot.value);
      if (!(result instanceof Promise)) return result;
      return applyTimeoutBudget(result, slot, spec);
    };
  };

  const runByIndex = listOfFunctions.reduce((acc, fixed, idx) => {
    const job = jobs[idx]!;
    acc.push(
      fixed.timeout
        ? composeTimedRunner(job, fixed.timeout)
        : composePlainRunner(job),
    );
    return acc;
  }, [] as Array<(slot: Task) => unknown>);

  const hasCompleted = workerOptions?.resolveAfterFinishingAll === true
    ? () => hasAnythingFinished !== 0 && toWork.size === 0
    : () => hasAnythingFinished !== 0;

const { decode, resolved } = lock;
const resolvedShift = resolved.shiftNoClear.bind(resolved);


const enqueueLock = () => {
  if (!decode()) return false;

  let task = resolvedShift();
  while (task) {
    task.resolve = PLACE_HOLDER;
    task.reject  = PLACE_HOLDER;
    toWorkPush(task);
    task = resolvedShift();
  }
  return true;
};

  const encodeReturnSafe = (slot: Task) => {
  
      if (!returnLock.encode(slot)) return false;

    return true;
  };

  const sendReturn = (slot: Task, shouldReject: boolean) => {
    slot[IDX_FLAGS] = shouldReject ? FLAG_REJECT : 0;
    if (!encodeReturnSafe(slot)) return false;
    hasAnythingFinished--;
    recyclePush(slot);
    return true;
  };

  const settleNow = (
    slot: Task,
    isError: boolean,
    value: unknown,
    wasAwaited: boolean,
  ) => {
    slot.value = value;
    hasAnythingFinished++;
    if (wasAwaited && awaiting > 0) awaiting--;
    const shouldReject = isError ||
      slot[IDX_FLAGS] === FLAG_REJECT;
    if (!sendReturn(slot, shouldReject)) pendingPush(slot);
  };

  const writeOne = () => {
    const slot = pendingShift();
    if (!slot) return false;
    if (!sendReturn(slot, slot[IDX_FLAGS] === FLAG_REJECT)) {
      pendingUnshift(slot);
      return false;
    }
    return true;
  };

  return {
    hasCompleted,
    hasPending: () => toWork.size !== 0,
    writeBatch: (max: number) => {
      let wrote = 0;
      while (wrote < max) {
        if (!writeOne()) break;
        wrote++;
      }
      return wrote;
    },
    serviceBatchImmediate: () => {
      let processed = 0;

      while (processed < 3) {
        const slot = toWorkShift();
        if (!slot) break;

        try {
          const result = runByIndex[slot[IDX_FN]]!(slot);
          // Slot 0 is reused for response flags; clear request FunctionID value.
          slot[IDX_FLAGS] = 0;
          if (result instanceof Promise) {
            awaiting++;

            result.then(
              (value) => settleNow(slot, false, value, true),
              (err) => settleNow(slot, true, err, true),
            );
          } else {
            settleNow(slot, false, result, false);
          }
        } catch (err) {
          settleNow(slot, true, err, false);
        }

        ++processed ;
       
      }

      return processed;
    },
    enqueueLock,
    hasAwaiting: () => awaiting > 0,
    getAwaiting: () => awaiting,
  };
};
