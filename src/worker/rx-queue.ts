import LinkList from "../ipc/tools/LinkList.ts";
import { TaskFlag, TaskIndex, type Task, type Lock2 } from "../memory/lock.ts";
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

  const isThenable = (value: unknown): value is PromiseLike<unknown> => {
    if (value == null) return false;
    const type = typeof value;
    if (type !== "object" && type !== "function") return false;
    return typeof (value as { then?: unknown }).then === "function";
  };

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.run), acc
  ), [] as Array<(args: unknown) => unknown>);

  const toWork = new LinkList<Task>();
  const completedFrames = new LinkList<Task>();
  const errorFrames = new LinkList<Task>();

  const toWorkPush = (slot: Task) => toWork.push(slot);
  const toWorkShift = () => toWork.shift();
  const completedShift = () => completedFrames.shift();
  const completedUnshift = (slot: Task) => completedFrames.unshift(slot);
  const completedPush = (slot: Task) => completedFrames.push(slot);
  const errorShift = () => errorFrames.shift();
  const errorUnshift = (slot: Task) => errorFrames.unshift(slot);
  const errorPush = (slot: Task) => errorFrames.push(slot);
  const recyclePush = (slot: Task) => lock.recyclecList.push(slot);

  const hasCompleted = workerOptions?.resolveAfterFinishingAll === true
    ? () => hasAnythingFinished !== 0 && toWork.size === 0
    : () => hasAnythingFinished !== 0;

const { decode, resolved } = lock;
const resolvedShift = resolved.shift.bind(resolved);


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

  const sendReturn = (slot: Task, isError: boolean) => {
    slot[TaskIndex.FlagsToHost] = isError ? TaskFlag.Reject : 0;
    if (!returnLock.encode(slot)) return false;
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
    if (wasAwaited) awaiting--;
    if (!sendReturn(slot, isError)) {
      if (isError) {
        errorPush(slot);
      } else {
        completedPush(slot);
      }
    }
  };

  const writeOne = () => {
    if (errorFrames.size > 0) {
      const slot = errorShift()!;
      if (!sendReturn(slot, true)) {
        errorUnshift(slot);
        return false;
      }
      return true;
    }

    if (completedFrames.size > 0) {
      const slot = completedShift()!;
      if (!sendReturn(slot, false)) {
        completedUnshift(slot);
        return false;
      }
      return true;
    }

    return false;
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


      while (toWork.size !== 0) {
        const slot = toWorkShift()!;

        try {
       
          const result = jobs[slot[TaskIndex.FuntionID]](slot.value);
          if (!isThenable(result)) {
            settleNow(slot, false, result, false);
          } else {
            awaiting++;
            result.then(
              (value) => settleNow(slot, false, value, true),
              (err) => settleNow(slot, true, err, true),
            );
          }
        } catch (err) {
          settleNow(slot, true, err, false);
        }

        processed++;
       
      }

      return processed;
    },
    enqueueLock,
    hasAwaiting: () => awaiting > 0,
    getAwaiting: () => awaiting,
  };
};
