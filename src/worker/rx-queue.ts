import RingQueue from "../ipc/tools/RingQueue.ts";
import {
  TaskFlag,
  TaskIndex,
  type Task,
  type Lock2,
} from "../memory/lock.ts";
import type { WorkerComposedWithKey } from "./get-functions.ts";
import { composeWorkerRunner } from "./composable-runners.ts";
import type {
  WorkerSettings,
} from "../types.ts";

type ArgumentsForCreateWorkerQueue = {
  listOfFunctions: WorkerComposedWithKey[];
  workerOptions?: WorkerSettings;
  lock: Lock2;
  returnLock: Lock2;
  hasAborted?: (signal: number) => boolean;
  now?: () => number;
};

export type CreateWorkerRxQueue = ReturnType<typeof createWorkerRxQueue>;
// Create and manage a working queue.
export const createWorkerRxQueue = (
  {
    listOfFunctions,
    workerOptions,
    lock,
    returnLock,
    hasAborted,
    now,
  }: ArgumentsForCreateWorkerQueue,
) => {
  const PLACE_HOLDER = (_?: unknown) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
  };

  let hasAnythingFinished = 0;
  let awaiting = 0;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.run), acc
  ), [] as Array<(args: unknown, abortToolkit?: unknown) => unknown>);

  const toWork = new RingQueue<Task>();
  const pendingFrames = new RingQueue<Task>();

  const toWorkPush = (slot: Task) => toWork.push(slot);
  const toWorkShift = () => toWork.shiftNoClear();
  const pendingShift = () => pendingFrames.shiftNoClear();
  const pendingUnshift = (slot: Task) => pendingFrames.unshift(slot);
  const pendingPush = (slot: Task) => pendingFrames.push(slot);
  const recyclePush = (slot: Task) => lock.recyclecList.push(slot);
  const FUNCTION_ID_MASK = 0xFFFF;
  const IDX_FLAGS = TaskIndex.FlagsToHost;
  const FLAG_REJECT = TaskFlag.Reject;

  const runByIndex = listOfFunctions.reduce((acc, fixed, idx) => {
    const job = jobs[idx]!;
    acc.push(composeWorkerRunner({
      job,
      timeout: fixed.timeout,
      hasAborted,
      now,
    }));
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
          const fnIndex = slot[TaskIndex.FunctionID] & FUNCTION_ID_MASK;
          const result = runByIndex[fnIndex]!(slot);
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
