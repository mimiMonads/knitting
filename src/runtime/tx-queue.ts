import LinkedList from "../ipc/tools/LinkList.ts";
import { makeTask, TaskIndex, type Task, type Lock2 } from "../memory/lock.ts";
import { withResolvers } from "../common/with-resolvers.ts";

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
  const toBeSentPush = toBeSent.push.bind(toBeSent);
  const toBeSentShift = toBeSent.shift.bind(toBeSent);
  const freePush = freeSockets.push.bind(freeSockets);
  const freePop = freeSockets.pop.bind(freeSockets);
  const queuePush = queue.push.bind(queue);
  let toBeSentCount = 0;
  let inUsed = 0;

  const resolveReturn = returnLock.resolveHost({
    queue,
    onResolved: (task) => {
      inUsed--;
      freePush(task[TaskIndex.ID]);
    },
  });

  // Helpers
  const hasPendingFrames = () => toBeSentCount > 0;
  const txIdle = () => toBeSentCount === 0 && inUsed === 0;

  const rejectAll = (reason: string) => {
    for (let index = 0; index < queue.length; index++) {
      const slot = queue[index];
      if (slot.reject !== PLACE_HOLDER) {
        try {
          slot.reject(reason);
        } catch {
        }

        queue[index] = newSlot(index);
      }
    }

    while (toBeSent.size > 0) {
      toBeSentShift();
    }
    toBeSentCount = 0;
    inUsed = 0;
  };

  const flushToWorker = () => {
    if (toBeSentCount === 0) return false;
    const encoded = lock.encodeManyFrom(toBeSent, toBeSentCount);
    if (encoded === 0) return false;
    toBeSentCount -= encoded;
    return true;
  };

  return {
    rejectAll,
    hasPendingFrames,
    txIdle,
    completeFrame: resolveReturn,
    enqueue: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      // Expanding size if needed
      if (inUsed === queue.length) {
        const newSize = inUsed + 10;
        let current = queue.length;

        while (newSize > current) {
          queuePush(newSlot(current));
          freePush(current);
          current++;
        }
      }

      const index = freePop()!;
      const slot = queue[index];
      const deferred = withResolvers<WorkerResponse>();

      // Set info
      slot.value = rawArgs;
      slot[TaskIndex.FuntionID] = functionID;
      slot[TaskIndex.ID] = index;
      slot.resolve = deferred.resolve;
      slot.reject = deferred.reject;

      if (!lock.encode(slot)) {
        toBeSentPush(slot);
        toBeSentCount++;
      }

      inUsed++;

      return deferred.promise;
    },
    flushToWorker,
  };
}
