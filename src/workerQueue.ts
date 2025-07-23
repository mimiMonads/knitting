import type { QueueListWorker } from "./mainQueueManager.ts";
import { type SignalArguments, type WorkerSignal } from "./signals.ts";
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

  type AsyncFunction = (...args: any[]) => Promise<any>;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.f), acc
  ), [] as AsyncFunction[]);

  const fromPlayloadToArgumentsWitSignal = fromPlayloadToArguments(signals);
  const fromreturnToMainWitSignal = fromreturnToMain(signals);
  const returnError = fromReturnToMainError(signals);

  const playloadToArgs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fromPlayloadToArgumentsWitSignal(
      //@ts-ignore
      fixed.args ?? "serializable",
    )), acc
  ), [] as Function[]);

  const returnToMain = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fromreturnToMainWitSignal(
      //@ts-ignore
      fixed.return ?? "serializable",
    )), acc
  ), [] as Function[]);

  return {
    // Check if any task is solved and ready for writing.
    someHasFinished: () => hasAnythingFinished !== 0,

    // enqueue a task to the queue.
    enqueue: () => {
      const fnNumber = functionToUse();
      let inserted = false;
      isThereAnythingToResolve++;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === -1) {
          const slot = queue[i];
          slot[4] = 0;
          slot[0] = getCurrentID();
          slot[1] = playloadToArgs[0]();
          slot[2] = fnNumber;
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
          0,
          PLACE_HOLDER,
          PLACE_HOLDER,
        ]);
      }

      readyToWork();
    },

    // Write completed tasks to the writer.
    write: () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === 2) {
          const element = queue[i];
          returnToMain[element[2]](element);
          messageReady();
          element[4] = -1;
          isThereAnythingToResolve--;
          hasAnythingFinished--;
          break;
        }
        if (queue[i][4] === 3) {
          const element = queue[i];
          returnError(element);
          errorWasThrown();
          element[4] = -1;
          isThereAnythingToResolve--;
          hasAnythingFinished--;
          break;
        }
      }
    },

    promify: () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === 0) {
          const task = queue[i];
          task[4] = 1;

          jobs[task[2]](task[1])
            .then((res) => {
              res = task[3] = res;
              task[4] = 2;
              hasAnythingFinished++;
            })
            .catch((err) => {
              err = task[3] = err;
              task[4] = 3;
              hasAnythingFinished++;
            });
        }
      }
    },

    // Process the next available task.
    nextJob: async () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === 0) {
          const task = queue[i];
          task[4] = 1;

          await jobs[task[2]](task[1])
            .then((res) => {
              res = task[3] = res;
              hasAnythingFinished++;
              task[4] = 2;
            })
            .catch((err) => {
              err = task[3] = err;
              hasAnythingFinished++;
              task[4] = 3;
            });

          break;
        }
      }
    },
    fastResolve: async () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === 0) {
          const task = queue[i];
          task[4] = 1;

          try {
            task[3] = await jobs[task[2]](task[1]);
            hasAnythingFinished++;
            task[4] = 2;
          } catch (err) {
            task[3] = err;
            task[4] = 3;
            hasAnythingFinished++;
          }
          break;
        }
      }
    },
    allDone: () => isThereAnythingToResolve === 0,
  };
};
