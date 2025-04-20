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
    someHasFinished: () => status.some((task) => task === 2),

    // enqueue a task to the queue.
    enqueue: () => {
      const slot = status.indexOf(-1),
        fnNumber = functionToUse();

      if (slot !== 1) {
        queue[slot][0] = getCurrentID();
        queue[slot][1] = playloadToArgs[fnNumber]();
        queue[slot][2] = fnNumber;

        status[slot] = 0;
      } else {
        queue.push([
          getCurrentID(),
          playloadToArgs[fnNumber](),
          fnNumber,
          new Uint8Array(),
        ]);

        status.push(0);
      }

      readyToWork();
    },

    // Write completed tasks to the writer.
    write: () => {
      const slot = status.indexOf(2);

      if (slot !== 1) {
        const element = queue[slot];

        returnToMain[element[2]](element);
        //writer(queue[finishedTaskIndex]);
        messageReady();
        status[slot] = -1;
      }
    },

    // Process the next available task.
    nextJob: async () => {
      const slot = status.indexOf(0);

      if (slot !== -1) {
        const task = queue[slot];

        status[slot] = 1;
        try {
          task[3] = await jobs[task[2]](
            task[1],
          );
        } finally {
          status[slot] = 2;
        }
      }
    },
    allDone: () =>
      status.every(
        (task) => task === -1,
      ),
  };
};
