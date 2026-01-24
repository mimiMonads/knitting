import "../polyfills/promise-with-resolvers.ts";
import LinkList from "../ipc/tools/LinkList.ts";
import { makeTask, TaskFlag, TaskIndex, type Task, type Lock2 } from "../memory/lock.ts";
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

  const newSlot = () => {
    const task = makeTask() as Task;
    task[TaskIndex.FuntionID] = 0;
    task[TaskIndex.ID] = 0;
    task.value = undefined;
    task.resolve = PLACE_HOLDER;
    task.reject = PLACE_HOLDER;
    return task;
  };

  type AsyncFunction = (...args: any[]) => Promise<any>;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.f), acc
  ), [] as AsyncFunction[]);

  const toWork = new LinkList<Task>();
  const completedFrames = new LinkList<Task>();
  const errorFrames = new LinkList<Task>();

  const enqueueSlot = (slot: Task) => {
    toWork.push(slot);
    return true;
  };

  const hasCompleted = workerOptions?.resolveAfterFinishingAll === true
    ? () => hasAnythingFinished !== 0 && toWork.size === 0
    : () => hasAnythingFinished !== 0;

  const enqueueLock = () => {
    if (!lock.decode()) {
      return false;
    }

    let task = lock.resolved.shift?.() as Task | undefined;
    while (task) {
      const slot = newSlot();
      slot.value = task.value;
      slot[TaskIndex.FuntionID] = task[TaskIndex.FuntionID];
      slot[TaskIndex.ID] = task[TaskIndex.ID];
      enqueueSlot(slot);
      task = lock.resolved.shift?.() as Task | undefined;
    }

    return true;
  };

  const sendReturn = (slot: Task, isError: boolean) => {
    slot[TaskIndex.FlagsToHost] = isError ? TaskFlag.Reject : 0;
    if (!returnLock.encode(slot)) return false;
    hasAnythingFinished--;
    return true;
  };

  const writeOne = () => {
    if (errorFrames.size > 0) {
      const slot = errorFrames.shift()!;
      if (!sendReturn(slot, true)) {
        errorFrames.unshift(slot);
        return false;
      }
      return true;
    }

    if (completedFrames.size > 0) {
      const slot = completedFrames.shift()!;
      if (!sendReturn(slot, false)) {
        completedFrames.unshift(slot);
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
      const deadline = timeBudgetMs
        ? performance.now() + timeBudgetMs
        : null;

      while (processed < max && toWork.size !== 0) {
        const slot = toWork.shift()!;

        try {
          slot.value = await jobs
            [slot[TaskIndex.FuntionID]](slot.value);
          hasAnythingFinished++;
          completedFrames.push(slot);
        } catch (err) {
          slot.value = err;
          hasAnythingFinished++;
          errorFrames.push(slot);
        }

        processed++;
        if (deadline && performance.now() >= deadline) break;
      }

      return processed;
    },
    enqueueLock,
  };
};
