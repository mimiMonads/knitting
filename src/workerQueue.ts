import type { QueueListWorker } from "./mainQueueManager.ts";
import { type SignalArguments, type WorkerSignal } from "./signals.ts";
import type { ComposedWithKey } from "./taskApi.ts";
import { fromPlayloadToArguments, fromreturnToMain } from "./parsers.ts";

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
    },
  }: ArgumentsForCreateWorkerQueue,
) => {
  const queue = Array.from(
    { length: max ?? 3 },
    () =>
      [
        0,
        new Uint8Array(),
        0,
        new Uint8Array(),
        -1,
      ] as QueueListWorker,
  );

  type AsyncFunction = (...args: any[]) => Promise<any>;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.f), acc
  ), [] as AsyncFunction[]);

  const fromPlayloadToArgumentsWitSignal = fromPlayloadToArguments(signals);
  const fromreturnToMainWitSignal = fromreturnToMain(signals);

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

  const status = Array.from({ length: max ?? 3 }, () => -1);

  return {
    // Check if any task is solved and ready for writing.
    someHasFinished: () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === 2) return true;
      }
      return false;
    },

    // enqueue a task to the queue.
    enqueue: () => {
      const fnNumber = functionToUse();
      let inserted = false;

      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === -1) {
          queue[i][4] = 0;
          queue[i][0] = getCurrentID();
          queue[i][1] = playloadToArgs[fnNumber]();
          queue[i][2] = fnNumber;
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
        ]);

        status.push(0);
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
          break;
        }
      }
    },

    // Process the next available task.
    nextJob: async () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === 0) {
          const task = queue[i];
          task[4] = 1;

          jobs[task[2]](task[1])
            .then((res) => res = task[3])
            .finally(() => task[4] = 2);

          break;
        }
      }
    },
    allDone: () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] !== -1) return false;
      }
      return true;
    },
  };
};
