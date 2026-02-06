import LinkedList from "../ipc/tools/LinkList.ts";
import {
  makeTask,
  PromisePayloadMarker,
  type PromisePayloadResult,
  TaskIndex,
  type Task,
  type Lock2,
} from "../memory/lock.ts";
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
  const toBeSentPush = (task: QueueTask) => toBeSent.push(task);
  const toBeSentShift = () => toBeSent.shift();
  const freePush = (id: number) => freeSockets.push(id);
  const freePop = () => freeSockets.pop();
  const queuePush = (task: QueueTask) => queue.push(task);
  const { encode , encodeManyFrom} = lock
  let toBeSentCount = 0;
  let inUsed = 0;
  let pendingPromises = 0;

  const isPromisePending = (task: QueueTask) =>
    (task as QueueTask & { [PromisePayloadMarker]?: true })[
      PromisePayloadMarker
    ] === true;

  const resolveReturn = returnLock.resolveHost({
    queue,
    onResolved: (task) => {
      inUsed--;
      freePush(task[TaskIndex.ID]);
    },
  });
  const resolveReturnOne = returnLock.resolveHostOne({
    queue,
    onResolved: (task) => {
      inUsed--;
      freePush(task[TaskIndex.ID]);
    },
  });

  // Helpers
  const hasPendingFrames = () => toBeSentCount > 0;
  const txIdle = () =>
    toBeSentCount === 0 && (inUsed - pendingPromises) === 0;

  const handleEncodeFailure = (task: QueueTask) => {
    if (isPromisePending(task)) {
      pendingPromises++;
      return;
    }
    toBeSentPush(task);
    toBeSentCount++;
  };

  const rejectAll = (reason: string) => {
    for (let index = 0; index < queue.length; index++) {
      const slot = queue[index];
      if (slot.reject !== PLACE_HOLDER) {
        try {
          slot.reject(reason);
        } catch {
        }
        slot.resolve = PLACE_HOLDER;
        slot.reject = PLACE_HOLDER;

        queue[index] = newSlot(index);
      }
    }

    while (toBeSent.size > 0) {
      toBeSentShift();
    }
    toBeSentCount = 0;
    inUsed = 0;
    pendingPromises = 0;
  };

  const flushToWorker = () => {
    if (toBeSentCount === 0) return false;
    const encoded = encodeManyFrom(toBeSent);
    if (encoded === 0) return false;
    toBeSentCount -= encoded;
    return true;
  };

  const enqueueKnown = (task: QueueTask) => {
    if (!encode(task)) {
      handleEncodeFailure(task);
      return false;
    }
    return true;
  };

  return {
    rejectAll,
    hasPendingFrames,
    txIdle,
    hasPendingFramesToResolve: lock.hasPendingFramesToResolve,
    completeFrame: resolveReturn,
    completeFrameOne: resolveReturnOne,
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

      if (!encode(slot)) {
        handleEncodeFailure(slot);
      }

      inUsed++;

      return deferred.promise;
    },
    flushToWorker,
    enqueueKnown,
    settlePromisePayload: (task: QueueTask, result: PromisePayloadResult) => {
      if (task.reject === PLACE_HOLDER) return false;
      if (pendingPromises > 0) pendingPromises--;
      if (result.status === "rejected") {
        try {
          task.reject(result.reason);
        } catch {
        }
        inUsed--;
        freePush(task[TaskIndex.ID]);
        return false;
      }

      task.value = result.value;
      return enqueueKnown(task);
    },
  };
}
