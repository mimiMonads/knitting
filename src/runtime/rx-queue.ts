import { type QueueListWorker } from "./tx-queue.ts";
import { MainListEnum } from "./tx-queue.ts";
import {
  OP,
  type SignalArguments,
  type WorkerSignal,
} from "../ipc/transport/shared-memory.ts";
import type { ComposedWithKey, WorkerSettings } from "../api.ts";
import {
  decodeArgs,
  fromReturnToMainError,
  PayloadType,
  preencodeJsonString,
  readFramePayload,
  writeFramePayload,
} from "../ipc/protocol/codec.ts";
import "../polyfills/promise-with-resolvers.ts";

type ArgumentsForCreateWorkerQueue = {
  listOfFunctions: ComposedWithKey[];
  max?: number;
  moreThanOneThread: boolean;
  signal: WorkerSignal;
  signals: SignalArguments;
  workerOptions?: WorkerSettings;
};

// Create and manage a
// working queue.
export const createWorkerRxQueue = (
  {
    listOfFunctions,
    signals,
    signal: {
      op,
      rpcId,
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
      ,
      0,
      ,
      PLACE_HOLDER,
      PLACE_HOLDER,
      PayloadType.UNREACHABLE,
      0,
    ] as QueueListWorker;

  const queue = Array.from(
    { length: 15 },
    newSlot,
  );

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
    from: "thread",
  })(signals);

  // Readers
  const reader = readFramePayload({
    ...signals,
    specialType: "thread",
  });

  const completedFrames: QueueListWorker[] = [];
  const errorFrames: QueueListWorker[] = [];
  const toWork: QueueListWorker[] = [];
  const optimizedFrames: QueueListWorker[] = [];
  const hasCompleted = workerOptions?.resolveAfterFinishinAll === true
    ? () => hasAnythingFinished !== 0 && toWork.length === 0
    : () => hasAnythingFinished !== 0;

  return {
    // Check if any task is solved and ready for writing.
    hasFramesToOptimize: () => completedFrames.length > 0,
    hasCompleted,
    hasPending: () => toWork.length !== 0,
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
      const slot = completedFrames.pop();
      if (slot) optimizedFrames.push(simplifies(slot));
    },

    //enqueue a task to the queue.
    enqueue: () => {
      const currentIndex = slotIndex[0],
        fnNumber = rpcId[0],
        args = reader();

      if (queue.length === 0) {
        let i = 0;

        while (i !== 15) {
          queue.push(newSlot());
          i++;
        }
      }

      const slot = queue.pop()!;
      slot[MainListEnum.RawArguments] = args;
      slot[MainListEnum.FunctionID] = fnNumber;
      slot[MainListEnum.slotIndex] = currentIndex;
      toWork.push(slot);
      isThereAnythingToResolve++;
    },

    write: () => {
      if (completedFrames.length > 0) {
        const slot = completedFrames.pop()!;
        slotIndex[0] = slot[MainListEnum.slotIndex];
        writeFrame(slot);
        op[0] = OP.WorkerWaiting;
        //queue.push(slot);
        isThereAnythingToResolve--;
        hasAnythingFinished--;

        return;
      }

      if (optimizedFrames.length > 0) {
        const slot = optimizedFrames.pop()!;
        slotIndex[0] = slot[MainListEnum.slotIndex];
        writeFrame(slot);
        op[0] = OP.WorkerWaiting;
        //queue.push(slot);
        isThereAnythingToResolve--;
        hasAnythingFinished--;
        return;
      }

      if (errorFrames.length > 0) {
        const slot = errorFrames.pop()!;
        slotIndex[0] = slot[MainListEnum.slotIndex];
        returnError(slot);
        op[0] = OP.ErrorThrown;
        //queue.push(slot);
        isThereAnythingToResolve--;
        hasAnythingFinished--;
      }
    },
    // Process the next available task.
    serviceOne: async () => {
      const slot = toWork.pop();

      if (slot !== undefined) {
        await jobs[slot[MainListEnum.FunctionID]](
          slot[MainListEnum.RawArguments],
        )
          .then((res) => {
            slot[MainListEnum.WorkerResponse] = res;
            hasAnythingFinished++;
            completedFrames.push(slot);
          })
          .catch((err) => {
            slot[MainListEnum.WorkerResponse] = err;
            hasAnythingFinished++;
            errorFrames.push(slot);
          });
      }
    },
    serviceOneImmediate: async () => {
      const slot = toWork.pop()!;

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
