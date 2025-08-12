import { type QueueListWorker } from "./mainQueueManager.ts";
import { MainListEnum } from "./mainQueueManager.ts";
import {
  type SignalArguments,
  SignalStatus,
  type WorkerSignal,
} from "./signals.ts";
import type { ComposedWithKey } from "./taskApi.ts";
import {
  fromPlayloadToArguments,
  fromReturnToMainError,
  PayloadType,
  readPayloadWorkerBulk,
  simplifyJson,
  writeToShareMemory,
} from "./parsers.ts";

type ArgumentsForCreateWorkerQueue = {
  listOfFunctions: ComposedWithKey[];
  max?: number;
  moreThanOneThread: boolean;
  signal: WorkerSignal;
  signals: SignalArguments;
};

// Create and manage a
// working queue.
export const createWorkerQueue = (
  {
    listOfFunctions,
    signals,
    signal: {
      status,
      functionToUse,
      slotIndex,
    },
    moreThanOneThread,
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
  const simplifies = simplifyJson({
    index: MainListEnum.WorkerResponse,
  });

  // Writers
  const returnError = fromReturnToMainError(signals);
  const playloadToArgs = fromPlayloadToArguments(signals);
  const returnToMain = writeToShareMemory({
    index: MainListEnum.WorkerResponse,
    jsonString: moreThanOneThread,
  })(signals);

  // Readers
  const reader = readPayloadWorkerBulk({
    ...signals,
    specialType: "thread",
  });

  const resolvedStack: QueueListWorker[] = [];
  const errorStack: QueueListWorker[] = [];
  const toWork: QueueListWorker[] = [];
  const optimzedStack: QueueListWorker[] = [];

  return {
    // Check if any task is solved and ready for writing.
    someHasFinished: () => hasAnythingFinished !== 0,
    isThereWorkToDO: () => toWork.length !== 0,
    blockingResolve: async () => {
      try {
        blockingSlot[MainListEnum.WorkerResponse] = await jobs
          [blockingSlot[MainListEnum.FunctionID]](
            playloadToArgs(),
          );
        returnToMain(blockingSlot);
        status[0] = SignalStatus.FastResolve;
      } catch (err) {
        blockingSlot[MainListEnum.WorkerResponse] = err;
        returnError(blockingSlot);
        status[0] = SignalStatus.ErrorThrown;
      }
    },

    preResolve: () => {
      const slot = resolvedStack.pop();

      if (slot !== undefined) {
        simplifies(slot);
        optimzedStack.push(slot);
      }
    },
    //enqueue a task to the queue.
    enqueue: () => {
      const currentIndex = slotIndex[0],
        fnNumber = functionToUse[0],
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
      if (resolvedStack.length > 0) {
        const slot = resolvedStack.pop()!;
        slotIndex[0] = slot[MainListEnum.slotIndex];
        returnToMain(slot);
        status[0] = SignalStatus.WorkerWaiting;
        queue.push(slot);
        isThereAnythingToResolve--;
        hasAnythingFinished--;

        return;
      }

      if (optimzedStack.length > 0) {
        const slot = optimzedStack.pop()!;
        slotIndex[0] = slot[MainListEnum.slotIndex];
        returnToMain(slot);
        status[0] = SignalStatus.WorkerWaiting;
        queue.push(slot);
        isThereAnythingToResolve--;
        hasAnythingFinished--;
        return;
      }

      if (errorStack.length > 0) {
        const slot = errorStack.pop()!;
        slotIndex[0] = slot[MainListEnum.slotIndex];
        returnError(slot);
        status[0] = SignalStatus.ErrorThrown;
        queue.push(slot);
        isThereAnythingToResolve--;
        hasAnythingFinished--;
      }
    },
    // Process the next available task.
    nextJob: async () => {
      const slot = toWork.pop();

      if (slot !== undefined) {
        await jobs[slot[MainListEnum.FunctionID]](
          slot[MainListEnum.RawArguments],
        )
          .then((res) => {
            slot[MainListEnum.WorkerResponse] = res;
            hasAnythingFinished++;
            resolvedStack.push(slot);
          })
          .catch((err) => {
            slot[MainListEnum.WorkerResponse] = err;
            hasAnythingFinished++;
            errorStack.push(slot);
          });
      }
    },
    fastResolve: async () => {
      const slot = toWork.pop()!;

      try {
        slot[MainListEnum.WorkerResponse] = await jobs
          [slot[MainListEnum.FunctionID]](slot[MainListEnum.RawArguments]);
        hasAnythingFinished++;
        resolvedStack.push(slot);
      } catch (err) {
        slot[MainListEnum.WorkerResponse] = err;
        hasAnythingFinished++;
        errorStack.push(slot);
      }
    },
    allDone: () => isThereAnythingToResolve === 0,
  };
};
