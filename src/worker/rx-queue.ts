import LinkList from "../ipc/tools/LinkList.ts";
import { TaskFlag, TaskIndex, type Task, type Lock2 } from "../memory/lock.ts";
import type {
  ComposedWithKey,
  WorkerSettings,
} from "../types.ts";

type ArgumentsForCreateWorkerQueue = {
  listOfFunctions: ComposedWithKey[];
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

  type AsyncFunction = (...args: any[]) => Promise<any>;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.f), acc
  ), [] as AsyncFunction[]);

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

  const enqueueLock = () => {
    if (!lock.decode()) {
      return false;
    }

    let task = lock.resolved.shift() as Task | undefined;
    while (task) {
      task.resolve = PLACE_HOLDER;
      task.reject = PLACE_HOLDER;
      toWorkPush(task);
      task = lock.resolved.shift() as Task | undefined;
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
    serviceBatchImmediate: async (max: number, timeBudgetMs?: number) => {
      let processed = 0;


      while (processed < max && toWork.size !== 0) {
        const slot = toWorkShift()!;

        try {
          slot.value = await jobs
            [slot[TaskIndex.FuntionID]](slot.value);
          hasAnythingFinished++;
          completedPush(slot);
         
        } catch (err) {
          slot.value = err;
          hasAnythingFinished++;
          errorPush(slot);
         
        }

        processed++;
       
      }

      return processed;
    },
    enqueueLock,
  };
};
