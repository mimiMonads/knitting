import { type QueueListWorker } from "./mainQueueManager.ts";
import { MainListEnum, MainListState } from "./mainQueueManager.ts";
import {
  type SignalArguments,
  SignalStatus,
  type WorkerSignal,
} from "./signals.ts";
import type { ComposedWithKey } from "./taskApi.ts";
import {
  fromPlayloadToArguments,
  fromreturnToMain,
  fromReturnToMainError,
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
    max,
    signals,
    signal: {
      status,
      getCurrentID,
      functionToUse,
      messageReady,
      readyToWork,
      errorWasThrown,
    },
  }: ArgumentsForCreateWorkerQueue,
) => {
  const PLACE_HOLDER = () => {
    throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
  };

  let isThereAnythingToResolve = 0;
  let hasAnythingFinished = 0;

  const queue = Array.from(
    { length: 10 },
    () =>
      [
        0,
        new Uint8Array(),
        0,
        new Uint8Array(),
        -1,
        PLACE_HOLDER,
        PLACE_HOLDER,
      ] as QueueListWorker,
  );

  const blockingSlot = [
    0,
    new Uint8Array(),
    0,
    new Uint8Array(),
    -1,
    PLACE_HOLDER,
    PLACE_HOLDER,
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

  return {
    // Check if any task is solved and ready for writing.
    someHasFinished: () => hasAnythingFinished !== 0,
    count: () => [isThereAnythingToResolve, hasAnythingFinished],
    blockingResolve: async () => {
      blockingSlot[MainListEnum.TaskID] = getCurrentID();

      try {
        blockingSlot[MainListEnum.WorkerResponse] = await jobs[blockingSlot[2]](
          playloadToArgs[0](),
        );
        returnToMain[functionToUse()](blockingSlot);
        status[0] = SignalStatus.FastResolve;
      } catch (err) {
        blockingSlot[MainListEnum.WorkerResponse] = err;
        returnError(blockingSlot);
        errorWasThrown();
      }
    },

    // enqueue a task to the queue.
    enqueue: () => {
      const fnNumber = functionToUse();
      let inserted = false;
      isThereAnythingToResolve++;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.State] === MainListState.Free) {
          const slot = queue[i];
          slot[MainListEnum.State] = MainListState.ToBeSent;
          slot[MainListEnum.TaskID] = getCurrentID();
          slot[MainListEnum.RawArguments] = playloadToArgs[0]();
          slot[MainListEnum.FunctionID] = fnNumber;
          inserted = true;
          break;
        }
      }

      if (!inserted) {
        queue.push([
          getCurrentID(),
          playloadToArgs[fnNumber](),
          fnNumber,
          new Uint8Array(),
          MainListState.ToBeSent,
          PLACE_HOLDER,
          PLACE_HOLDER,
        ]);
      }

      readyToWork();
    },

    // Write completed tasks to the writer.
    write: () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.State] === MainListState.Accepted) {
          const element = queue[i];
          returnToMain[element[MainListEnum.FunctionID]](element);
          messageReady();
          element[MainListEnum.State] = MainListState.Free;
          isThereAnythingToResolve--;
          hasAnythingFinished--;
          break;
        }
        if (queue[i][MainListEnum.State] === MainListState.Rejected) {
          const element = queue[i];
          returnError(element);
          errorWasThrown();
          element[MainListEnum.State] = MainListState.Free;
          isThereAnythingToResolve--;
          hasAnythingFinished--;
          break;
        }
      }
    },
    // Process the next available task.
    nextJob: async () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.State] === MainListState.ToBeSent) {
          const task = queue[i];
          task[MainListEnum.State] = MainListState.Sent;

          await jobs[task[2]](task[1])
            .then((res) => {
              task[MainListEnum.WorkerResponse] = res;
              hasAnythingFinished++;
              task[MainListEnum.State] = MainListState.Accepted;
            })
            .catch((err) => {
              task[MainListEnum.WorkerResponse] = err;
              hasAnythingFinished++;
              task[MainListEnum.State] = MainListState.Rejected;
            });

          break;
        }
      }
    },
    fastResolve: async () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.State] === 0) {
          const task = queue[i];
          task[MainListEnum.State] = MainListState.Sent;

          try {
            task[MainListEnum.WorkerResponse] = await jobs[task[2]](task[1]);
            hasAnythingFinished++;
            task[MainListEnum.State] = MainListState.Accepted;
          } catch (err) {
            task[MainListEnum.WorkerResponse] = err;
            task[MainListEnum.State] = MainListState.Rejected;
            hasAnythingFinished++;
          }

          break;
        }
      }
    },
    allDone: () => isThereAnythingToResolve === 0,
  };
};
