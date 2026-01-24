import "../polyfills/promise-with-resolvers.ts";
import LinkedList from "../ipc/tools/LinkList.ts";
import { makeTask, TaskIndex, type Task, type Lock2 } from "../memory/lock.ts";

type RawArguments = unknown;
type WorkerResponse = unknown;
type FunctionID = number;
type QueueTask = Task;

export type MultiQueue = ReturnType<typeof createHostTxQueue>;

type CreateHostTxQueueArgs = {
  max?: number;
  lock: Lock2;
  returnLock: Lock2;
};

export function createHostTxQueue({
  max,
  lock,
  returnLock,
}: CreateHostTxQueueArgs) {
  const PLACE_HOLDER = (_?: unknown) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (main)");
  };

  const newSlot = (id: number) => {
    const task = makeTask() as QueueTask;
    task[TaskIndex.ID] = id;
    task[TaskIndex.FuntionID] = 0;
    task.value = undefined;
    task.resolve = PLACE_HOLDER;
    task.reject = PLACE_HOLDER;
    return task;
  };

  const queue = Array.from(
    { length: max ?? 10 },
    (_, index) => newSlot(index),
  );

  const freeSockets = Array.from(
    { length: max ?? 10 },
    (_, i) => i,
  );

  // Local count
  const toBeSent = new LinkedList<QueueTask>();
  let toBeSentCount = 0;
  let inUsed = 0;

  const resolveReturn = returnLock.resolveHost({
    queue,
    onResolved: (task) => {
      inUsed--;
      freeSockets.push(task[TaskIndex.ID]);
    },
  });

  // Helpers
  const hasPendingFrames = () => toBeSentCount > 0;
  const txIdle = () => toBeSentCount === 0 && inUsed === 0;

  const rejectAll = (reason: string) => {
    queue.forEach((slot, index) => {
      if (slot.reject !== PLACE_HOLDER) {
        try {
          slot.reject(reason);
        } catch {
        }

        queue[index] = newSlot(index);
      }
    });

    while (toBeSent.size > 0) {
      toBeSent.shift();
    }
    toBeSentCount = 0;
    inUsed = 0;
  };

  const flushToWorker = () => {
    const slot = toBeSent.shift();
    if (!slot) return false;

    if (!lock.encode(slot)) {
      toBeSent.unshift(slot);
      return false;
    }

    toBeSentCount--;
    return true;
  };

  return {
    rejectAll,
    hasPendingFrames,
    txIdle,
    completeFrame: () => resolveReturn(),
    enqueue: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      // Expanding size if needed
      if (inUsed === queue.length) {
        const newSize = inUsed + 10;
        let current = queue.length;

        while (newSize > current) {
          queue.push(newSlot(current));
          freeSockets.push(current);
          current++;
        }
      }

      const index = freeSockets.pop()!;
      const slot = queue[index];
      const deferred = Promise.withResolvers<WorkerResponse>();

      // Set info
      slot.value = rawArgs;
      slot[TaskIndex.FuntionID] = functionID;
      slot[TaskIndex.ID] = index;
      slot.resolve = deferred.resolve;
      slot.reject = deferred.reject;

      if (!lock.encode(slot)) {
        toBeSent.push(slot);
        toBeSentCount++;
      }

      inUsed++;

      return deferred.promise;
    },
    flushToWorker,
  };
}
