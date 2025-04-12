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
        -1,
        0,
        new Uint8Array(),
        0,
        new Uint8Array(),
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

  return {
    // Check if any task is solved and ready for writing.
    someHasFinished: () => queue.some((task) => task[0] === 2),

    // enqueue a task to the queue.
    enqueue: () => {
      const freeSlot = queue.find((task) => task[0] === -1),
        fnNumber = functionToUse();

      if (freeSlot) {
        freeSlot[0] = 0;
        freeSlot[1] = getCurrentID();
        freeSlot[2] = playloadToArgs[fnNumber]();
        freeSlot[3] = fnNumber;
      } else {
        queue.push([
          0,
          getCurrentID(),
          playloadToArgs[fnNumber](),
          fnNumber,
          new Uint8Array(),
        ]);
      }

      readyToWork();
    },

    // Write completed tasks to the writer.
    write: () => {
      const element = queue.find((task) => task[0] === 2);
      if (element !== undefined) {
        returnToMain[element[3]](element);
        //writer(queue[finishedTaskIndex]);
        messageReady();
        element[0] = -1;
      }
    },

    // Process the next available task.
    nextJob: async () => {
      const task = queue.find((task) => task[0] === 0);

      if (task !== undefined) {
        task[0] = 1;
        try {
          //@ts-ignore
          task[4] = await jobs[task[3]](
            task[2],
          );
        } finally {
          task[0] = 2;
        }
      }
    },
    allDone: () =>
      queue.every(
        (task) => task[0] === -1,
      ),
  };
};
