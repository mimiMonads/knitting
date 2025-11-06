import {
  OP,
  type SignalArguments,
  type WorkerSignal,
} from "../ipc/transport/shared-memory.ts";
import type {
  ComposedWithKey,
  QueueListWorker,
  WorkerSettings,
} from "../types.ts";
import {
  decodeArgs,
  fromReturnToMainError,
  preencodeJsonString,
  readFramePayload,
  writeFramePayload,
} from "../ipc/protocol/codec.ts";
import { MainListEnum, PayloadType } from "../types.ts";
import "../polyfills/promise-with-resolvers.ts";
import LinkList from "../ipc/tools/LinkList.ts";

type ArgumentsForCreateWorkerQueue = {
  listOfFunctions: ComposedWithKey[];
  max?: number;
  moreThanOneThread: boolean;
  signal: WorkerSignal;
  signals: SignalArguments;
  secondChannel: SignalArguments;
  workerOptions?: WorkerSettings;
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
  }: ArgumentsForCreateWorkerQueue,
) => {
  const PLACE_HOLDER = () => {
    throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
  };

  let isThereAnythingToResolve = 0;
  let hasAnythingFinished = 0;

  const newSlot = () =>
    [
      0,
      ,
      0,
      ,
      PLACE_HOLDER,
      PLACE_HOLDER,
      PayloadType.UNREACHABLE,
    ] as QueueListWorker;

  const blockingSlot = newSlot();

  type AsyncFunction = (...args: any[]) => Promise<any>;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.f), acc
  ), [] as AsyncFunction[]);

  // Parser
  const simplifies = preencodeJsonString({
    index: MainListEnum.WorkerResponse,
  });

  // Writers
  const returnError = fromReturnToMainError(signals);
  const playloadToArgs = decodeArgs(signals);
  const writeFrame = writeFramePayload({
    index: MainListEnum.WorkerResponse,
    jsonString: true,
  })(signals);

  // Readers
  const reader = readFramePayload({
    ...signals,
    specialType: "thread",
  });

  const toWork = new LinkList<QueueListWorker>();
  const completedFrames = new LinkList<QueueListWorker>();
  const errorFrames = new LinkList<QueueListWorker>();
  const optimizedFrames = new LinkList<QueueListWorker>();

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
      slot[MainListEnum.RawArguments] = args;
      slot[MainListEnum.FunctionID] = fnNumber;
      slot[MainListEnum.slotIndex] = currentIndex;
      toWork.push(slot);
      isThereAnythingToResolve++;

      return true;
    };
  };

  const firstFrame = channelEnqueued(signals, signals);

  return {
    // Check if any task is solved and ready for writing.
    hasFramesToOptimize: () => completedFrames.size > 0,
    hasCompleted,
    hasPending: () => toWork.size !== 0,
    blockingResolve: async () => {
      try {
        blockingSlot[MainListEnum.WorkerResponse] = await jobs
          [blockingSlot[MainListEnum.FunctionID]](
            playloadToArgs(),
          );
        writeFrame(blockingSlot);
        op[0] = OP.FastResolve;
      } catch (err) {
        blockingSlot[MainListEnum.WorkerResponse] = err;
        returnError(blockingSlot);
        op[0] = OP.ErrorThrown;
      }
    },

    preResolve: () => {
      const slot = completedFrames.shift();
      if (slot) optimizedFrames.push(simplifies(slot));
    },

    //enqueue a task to the queue.
    enqueue: firstFrame,

    write: () => {
      if (errorFrames.size > 0) {
        const slot = errorFrames.shift()!;
        slotIndex[0] = slot[MainListEnum.slotIndex];
        returnError(slot);
        op[0] = OP.ErrorThrown;
        isThereAnythingToResolve--;
        hasAnythingFinished--;
      }

      if (optimizedFrames.size > 0) {
        const slot = optimizedFrames.shift()!;
        slotIndex[0] = slot[MainListEnum.slotIndex];
        writeFrame(slot);
        op[0] = OP.WorkerWaiting;
        isThereAnythingToResolve--;
        hasAnythingFinished--;
        return;
      }

      if (completedFrames.size > 0) {
        const slot = completedFrames.shift()!;
        slotIndex[0] = slot[MainListEnum.slotIndex];
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
        await jobs[slot[MainListEnum.FunctionID]](
          slot[MainListEnum.RawArguments],
        )
          .then((res: unknown) => {
            slot[MainListEnum.WorkerResponse] = res;
            hasAnythingFinished++;
            completedFrames.push(slot);
          })
          .catch((err: unknown) => {
            slot[MainListEnum.WorkerResponse] = err;
            hasAnythingFinished++;
            errorFrames.push(slot);
          });
      }
    },
    serviceOneImmediate: async () => {
      const slot = toWork.shift()!;

      try {
        slot[MainListEnum.WorkerResponse] = await jobs
          [slot[MainListEnum.FunctionID]](slot[MainListEnum.RawArguments]);
        hasAnythingFinished++;
        completedFrames.push(slot);
      } catch (err) {
        slot[MainListEnum.WorkerResponse] = err;
        hasAnythingFinished++;
        errorFrames.push(slot);
      }
    },
    allDone: () => isThereAnythingToResolve === 0,
  };
};
