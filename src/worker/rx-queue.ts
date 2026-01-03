import {
  OP,
  frameFlagsFlag,
  type SignalArguments,
  type WorkerSignal,
} from "../ipc/transport/shared-memory.ts";
import { makeTask, TaskIndex, type Task } from "../memory/lock.ts";
import type {
  ComposedWithKey,
  WorkerSettings,
} from "../types.ts";
import {
  decodeArgs,
  fromReturnToMainError,
  preencodeJsonString,
  readFramePayload,
  writeFramePayload,
} from "../ipc/protocol/codec.ts";
import { PayloadType } from "../types.ts";
import "../polyfills/promise-with-resolvers.ts";
import LinkList from "../ipc/tools/LinkList.ts";

type ArgumentsForCreateWorkerQueue = {
  listOfFunctions: ComposedWithKey[];
  max?: number;
  moreThanOneThread: boolean;
  signal: WorkerSignal;
  signals: SignalArguments;
  workerOptions?: WorkerSettings;
  lock?: ReturnType<typeof import("../memory/lock.ts").lock2>;
};

export type CreateWorkerRxQueue = ReturnType<typeof createWorkerRxQueue>;
// Create and manage a
// working queue.
export const createWorkerRxQueue = (
  {
    listOfFunctions,
    signals,
    signal: {
      op,
      slotIndex,
    },
    workerOptions,
    lock,
  }: ArgumentsForCreateWorkerQueue,
) => {
  const PLACE_HOLDER = (_?: unknown) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
  };

  let isThereAnythingToResolve = 0;
  let hasAnythingFinished = 0;

  const newSlot = () => {
    const task = makeTask() as Task;
    task[TaskIndex.FuntionID] = 0;
    task[TaskIndex.ID] = 0;
    task.value = undefined;
    task.payloadType = PayloadType.Undefined;
    task.resolve = PLACE_HOLDER;
    task.reject = PLACE_HOLDER;
    return task;
  };

  const blockingSlot = newSlot();

  type AsyncFunction = (...args: any[]) => Promise<any>;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.f), acc
  ), [] as AsyncFunction[]);

  // Parser
  const simplifies = preencodeJsonString();

  // Writers
  const returnError = fromReturnToMainError(signals);
  const playloadToArgs = decodeArgs(signals);
  const writeFrame = writeFramePayload({
    jsonString: true,
  })(signals);

  // Readers
  const reader = readFramePayload({
    ...signals,
    specialType: "thread",
  });

  const toWork = new LinkList<Task>();
  const completedFrames = new LinkList<Task>();
  const errorFrames = new LinkList<Task>();
  const optimizedFrames = new LinkList<Task>();

  const enqueueSlot = (slot: Task) => {
    toWork.push(slot);
    isThereAnythingToResolve++;
    return true;
  };

  const hasCompleted = workerOptions?.resolveAfterFinishingAll === true
    ? () => hasAnythingFinished !== 0 && toWork.size === 0
    : () => hasAnythingFinished !== 0;

  const channelEnqueued = (
    mainOP: SignalArguments,
    thisChanne: SignalArguments,
  ) => {
    const reader = readFramePayload({
      ...thisChanne,
      frameFlags: mainOP.frameFlags,
      specialType: "thread",
    });

    const { op, slotIndex, rpcId } = thisChanne;

    return () => {
      //if (op[0] !== OP.MainSend) return false;

      const currentIndex = slotIndex[0],
        fnNumber = rpcId[0],
        args = reader();

      const slot = newSlot();
      slot.value = args;
      slot.payloadType = PayloadType.Undefined;
      slot[TaskIndex.FuntionID] = fnNumber;
      slot[TaskIndex.ID] = currentIndex;
      return enqueueSlot(slot);
    };
  };

  const firstFrame = channelEnqueued(signals, signals);
  const enqueueLock = () => {
    if (!lock) return false;
    if (!lock.decode()) {
      op[0] = OP.MainReadyToRead;
      return false;
    }

    let task = lock.resolved.shift?.() as Task | undefined;
    while (task) {
      const slot = newSlot();
      slot.value = task.value;
      slot.payloadType = PayloadType.Undefined;
      slot[TaskIndex.FuntionID] = task[TaskIndex.FuntionID];
      slot[TaskIndex.ID] = task[TaskIndex.ID];
      enqueueSlot(slot);
      task = lock.resolved.shift?.() as Task | undefined;
    }

    op[0] = signals.frameFlags[0] === frameFlagsFlag.Last
      ? OP.WaitingForMore
      : OP.MainReadyToRead;

    return true;
  };

  return {
    // Check if any task is solved and ready for writing.
    hasFramesToOptimize: () => completedFrames.size > 0,
    hasCompleted,
    hasPending: () => toWork.size !== 0,
    blockingResolve: async () => {
      blockingSlot[TaskIndex.FuntionID] = signals.rpcId[0];
      blockingSlot.payloadType = PayloadType.Undefined;
      try {
        blockingSlot.value = await jobs
          [blockingSlot[TaskIndex.FuntionID]](
            playloadToArgs(),
          );
        writeFrame(blockingSlot);
        op[0] = OP.FastResolve;
      } catch (err) {
        blockingSlot.value = err;
        returnError(blockingSlot);
        op[0] = OP.ErrorThrown;
      }
    },
    blockingResolveLock: async () => {
      if (!lock) return;
      if (!lock.decode()) {
        op[0] = OP.MainReadyToRead;
        return;
      }

      const task = lock.resolved.shift?.() as Task | undefined;
      if (!task) {
        op[0] = OP.MainReadyToRead;
        return;
      }

      blockingSlot[TaskIndex.FuntionID] = task[TaskIndex.FuntionID];
      blockingSlot.value = task.value;
      blockingSlot.payloadType = PayloadType.Undefined;

      try {
        blockingSlot.value = await jobs
          [blockingSlot[TaskIndex.FuntionID]](
            blockingSlot.value,
          );
        writeFrame(blockingSlot);
        op[0] = OP.FastResolve;
      } catch (err) {
        blockingSlot.value = err;
        returnError(blockingSlot);
        op[0] = OP.ErrorThrown;
      }

      let extra = lock.resolved.shift?.() as Task | undefined;
      while (extra) {
        const slot = newSlot();
        slot.value = extra.value;
        slot.payloadType = PayloadType.Undefined;
        slot[TaskIndex.FuntionID] = extra[TaskIndex.FuntionID];
        slot[TaskIndex.ID] = extra[TaskIndex.ID];
        enqueueSlot(slot);
        extra = lock.resolved.shift?.() as Task | undefined;
      }
    },

    preResolve: () => {
      const slot = completedFrames.shift();
      if (slot) optimizedFrames.push(simplifies(slot));
    },

    //enqueue a task to the queue.
    enqueue: firstFrame,
    enqueueLock,

    write: () => {
      if (errorFrames.size > 0) {
        const slot = errorFrames.shift()!;
        slotIndex[0] = slot[TaskIndex.ID];
        returnError(slot);
        op[0] = OP.ErrorThrown;
        isThereAnythingToResolve--;
        hasAnythingFinished--;
      }

      if (optimizedFrames.size > 0) {
        const slot = optimizedFrames.shift()!;
        slotIndex[0] = slot[TaskIndex.ID];
        writeFrame(slot);
        op[0] = OP.WorkerWaiting;
        isThereAnythingToResolve--;
        hasAnythingFinished--;
        return;
      }

      if (completedFrames.size > 0) {
        const slot = completedFrames.shift()!;
        slotIndex[0] = slot[TaskIndex.ID];
        writeFrame(slot);
        op[0] = OP.WorkerWaiting;
        isThereAnythingToResolve--;
        hasAnythingFinished--;

        return;
      }
    },
    // Process the next available task.
    serviceOne: async () => {
      const slot = toWork.shift();

      if (slot !== undefined) {
        await jobs[slot[TaskIndex.FuntionID]](
          slot.value,
        )
          .then((res: unknown) => {
            slot.value = res;
            hasAnythingFinished++;
            completedFrames.push(slot);
          })
          .catch((err: unknown) => {
            slot.value = err;
            hasAnythingFinished++;
            errorFrames.push(slot);
          });
      }
    },
    serviceOneImmediate: async () => {
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
    },
    allDone: () => isThereAnythingToResolve === 0,
  };
};
