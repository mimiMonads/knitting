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
  signal: WorkerSignal;
  signals: SignalArguments;
};

// Create and manage a working queue.
export const createWorkerQueue = (
  {
    listOfFunctions,
    signals,
    signal: {
      status,
      functionToUse,
      slotIndex,
    },
  }: ArgumentsForCreateWorkerQueue,
) => {
  const PLACE_HOLDER = () => {
    throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
  };

  let isThereAnythingToResolve = 0;
  let hasAnythingFinished = 0;

  let countSlot = 0;
  const newSlot = () =>
    [
      ,
      0,
      ,
      PLACE_HOLDER,
      PLACE_HOLDER,
      PayloadType.UNREACHABLE,
      countSlot++
    ] as QueueListWorker;

  const queue = Array.from(
    { length: 15 },
    newSlot,
  );


  const blockingSlot = [
    ,
    0,
    ,
    PLACE_HOLDER,
    PLACE_HOLDER,
    PayloadType.UNREACHABLE,
    countSlot++
  ] as QueueListWorker;

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
    //jsonString: true,
  })(signals);

  // Readers
  const reader = readPayloadWorkerBulk({
    ...signals,
    specialType: "thread",
  });

  const resolvedStack: number[] = [];
  const errorStack: number[] = [];
  const toWork: number[] = [];
  const optimzedStack: number[] = [];

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

    // preResolve: () => {
    //   const index = resolvedStack.pop();

    //   if (index !== undefined) {
    //     simplifies(queue[index]);
    //     optimzedStack.push(index);
    //   }
    // },
    //enqueue a task to the queue.
    enqueue: () => {
      const currentIndex = slotIndex[0],
        fnNumber = functionToUse[0],
        args = reader();

      if (queue.length < currentIndex) {
        const newSize = currentIndex + 50;

        while (newSize > queue.length) {
          queue.push(newSlot());
        }
      }
      toWork.push(currentIndex);
      const slot = queue[currentIndex];
      slot[MainListEnum.RawArguments] = args;
      slot[MainListEnum.FunctionID] = fnNumber;
      slot[MainListEnum.slotIndex] = currentIndex
      isThereAnythingToResolve++;
    },

    write: () => {
      if (resolvedStack.length > 0) {
        const index = resolvedStack.pop()!,
          slot = queue[index];
        slotIndex[0] = index;
        returnToMain(slot);
        status[0] = SignalStatus.WorkerWaiting;
        isThereAnythingToResolve--;
        hasAnythingFinished--;
        return;
      }

      // if (optimzedStack.length > 0) {
      //   const index = optimzedStack.pop()!,
      //     slot = queue[index];
      //   slotIndex[0] = index;
      //   returnToMain(slot);
      //   status[0] = SignalStatus.WorkerWaiting;
      //   isThereAnythingToResolve--;
      //   hasAnythingFinished--;
      //   return;
      // }

      if (errorStack.length > 0) {
        const index = errorStack.pop()!,
          slot = queue[index];
        slotIndex[0] = index;
        returnError(slot);
        status[0] = SignalStatus.ErrorThrown;
        isThereAnythingToResolve--;
        hasAnythingFinished--;
      }
    },
    // Process the next available task.
    nextJob: async () => {
      const index = toWork.pop();

      if (index !== undefined) {
        const task = queue[index];

        await jobs[task[MainListEnum.FunctionID]](
          task[MainListEnum.RawArguments],
        )
          .then((res) => {
            task[MainListEnum.WorkerResponse] = res;
            hasAnythingFinished++;
            resolvedStack.push(index);
          })
          .catch((err) => {
            task[MainListEnum.WorkerResponse] = err;
            hasAnythingFinished++;
            errorStack.push(index);
          });
      }
    },
    fastResolve: async () => {
      const index = toWork.pop()!,
        task = queue[index];
      try {
        task[MainListEnum.WorkerResponse] = await jobs
          [task[MainListEnum.FunctionID]](task[MainListEnum.RawArguments]);
        hasAnythingFinished++;
        resolvedStack.push(index);
      } catch (err) {
        task[MainListEnum.WorkerResponse] = err;
        hasAnythingFinished++;
        errorStack.push(index);
      }
    },
    allDone: () => isThereAnythingToResolve === 0,
  };
};
