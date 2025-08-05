import { type QueueListWorker } from "./mainQueueManager.ts";
import { MainListEnum, MainListState } from "./mainQueueManager.ts";
import {
  QueueStateFlag,
  type SignalArguments,
  SignalStatus,
  type WorkerSignal,
} from "./signals.ts";
import type { ComposedWithKey } from "./taskApi.ts";
import {
  fromPlayloadToArguments,
  fromreturnToMain,
  fromReturnToMainError,
  PayloadType,
  readPayloadWorkerBulk,
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
      id,
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

  const newSlot = () =>
    [
      0,
      ,
      0,
      ,
      MainListState.Free,
      PLACE_HOLDER,
      PLACE_HOLDER,
      PayloadType.Undefined,
    ] as QueueListWorker;

  const queue = Array.from(
    { length: 10 },
    newSlot,
  );

  const blockingSlot = [
    0,
    ,
    0,
    ,
    MainListState.Free,
    PLACE_HOLDER,
    PLACE_HOLDER,
    PayloadType.Undefined,
  ] as QueueListWorker;

  type AsyncFunction = (...args: any[]) => Promise<any>;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.f), acc
  ), [] as AsyncFunction[]);

  const fromPlayloadToArgumentsWitSignal = fromPlayloadToArguments(signals);
  const fromreturnToMainWitSignal = fromreturnToMain(signals);
  const returnError = fromReturnToMainError(signals);

  const playloadToArgs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fromPlayloadToArgumentsWitSignal(
      "serializable",
    )), acc
  ), [] as Function[]);

  const returnToMain = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fromreturnToMainWitSignal(
      "serializable",
    )), acc
  ), [] as Function[]);

  const reader = readPayloadWorkerBulk({
    ...signals,
    specialType: "thread",
  });

  const resolvedStack: number[] = [];
  const errorStack: number[] = [];
  const toWork: number[] = [];

  return {
    // Check if any task is solved and ready for writing.
    someHasFinished: () => hasAnythingFinished !== 0,
    count: () => [isThereAnythingToResolve, hasAnythingFinished],
    blockingResolve: async () => {
      blockingSlot[MainListEnum.TaskID] = id[0];

      try {
        blockingSlot[MainListEnum.WorkerResponse] = await jobs[blockingSlot[2]](
          playloadToArgs[0](),
        );
        returnToMain[functionToUse[0]](blockingSlot);
        status[0] = SignalStatus.FastResolve;
      } catch (err) {
        blockingSlot[MainListEnum.WorkerResponse] = err;
        returnError(blockingSlot);
        status[0] = SignalStatus.ErrorThrown;
      }
    },

    // enqueue a task to the queue.
    enqueue: () => {
      const currentIndex = slotIndex[0],
        fnNumber = functionToUse[0],
        currentID = id[0],
        args = reader();

      if (queue.length <= currentIndex) {
        const newSize = currentIndex + 50;

        while (newSize > queue.length) {
          queue.push(newSlot());
        }
      }
      toWork.push(currentIndex);
      isThereAnythingToResolve++;
      const slot = queue[currentIndex];
      slot[MainListEnum.PlayloadType] = currentIndex;
      slot[MainListEnum.TaskID] = currentID;
      slot[MainListEnum.RawArguments] = args;
      slot[MainListEnum.FunctionID] = fnNumber;
    },

    write: () => {
      if (resolvedStack.length > 0) {
        const idx = resolvedStack.pop()!;
        const element = queue[idx];
        slotIndex[0] = element[MainListEnum.PlayloadType];
        returnToMain[element[MainListEnum.FunctionID]](element);
        status[0] = SignalStatus.WorkerWaiting;
        isThereAnythingToResolve--;
        hasAnythingFinished--;
        return;
      }

      if (errorStack.length > 0) {
        const idx = errorStack.pop()!;
        const element = queue[idx];
        slotIndex[0] = element[MainListEnum.PlayloadType];
        returnError(element);
        status[0] = SignalStatus.ErrorThrown;
        isThereAnythingToResolve--;
        hasAnythingFinished--;
      }
    },
    // Process the next available task.
    nextJob: async () => {
      const idx = toWork.pop();

      if (idx !== undefined) {
        const task = queue[idx];

        await jobs[task[MainListEnum.FunctionID]](
          task[MainListEnum.RawArguments],
        )
          .then((res) => {
            task[MainListEnum.WorkerResponse] = res;
            hasAnythingFinished++;
            resolvedStack.push(idx);
          })
          .catch((err) => {
            task[MainListEnum.WorkerResponse] = err;
            hasAnythingFinished++;
            errorStack.push(idx);
          });
      }
    },
    fastResolve: async () => {
      const idx = toWork.pop();

      if (idx !== undefined) {
        const task = queue[idx];
        try {
          task[MainListEnum.WorkerResponse] = await jobs
            [task[MainListEnum.FunctionID]](task[MainListEnum.RawArguments]);
          hasAnythingFinished++;
          resolvedStack.push(idx);
        } catch (err) {
          task[MainListEnum.WorkerResponse] = err;
          hasAnythingFinished++;
          errorStack.push(idx);
        }
      }
    },
    allDone: () => isThereAnythingToResolve === 0,
  };
};
