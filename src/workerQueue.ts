import type { PartialQueueList, QueueList } from "./mainQueue.ts";
import {
  signalsForWorker,
  type StatusSignal,
  type WorkerSignal,
} from "./signal.ts";

type ArgumetnsForMulti = {
  jobs: [Function, StatusSignal][];
  max?: number;
  writer: (job: QueueList) => void;
  reader: () => Uint8Array;
  signal: WorkerSignal;
};
// Create and manage a working queue.
export const multi = (
  { jobs, max, writer, signal, reader }: ArgumetnsForMulti,
) => {
  const queue = Array.from(
    { length: max ?? 10 },
    () =>
      [
        false,
        false,
        false,
        0,
        new Uint8Array(),
        0,
        new Uint8Array(),
        224,
      ] as QueueList,
  );

  return {
    // Check if any task is solved and ready for writing.
    someHasFinished: () => queue.some((task) => task[2] === true),

    // Add a task to the queue.
    add: (statusSignal: StatusSignal) => () => {
      const freeSlot = queue.findIndex((task) => !task[0]);

      if (freeSlot !== -1) {
        queue[freeSlot][0] = true;
        queue[freeSlot][3] = signal.getCurrentID();
        queue[freeSlot][4] = reader();
        queue[freeSlot][5] = signal.functionToUse();
        queue[freeSlot][7] = statusSignal;
      } else {
        queue.push([
          true,
          false,
          false,
          signal.getCurrentID(),
          reader(),
          signal.functionToUse(),
          new Uint8Array(),
          statusSignal,
        ]);
      }

      signal.readyToRead();
    },

    // Write completed tasks to the writer.
    write: () => {
      const finishedTaskIndex = queue.findIndex((task) => task[2]);
      if (finishedTaskIndex !== -1) {
        writer(queue[finishedTaskIndex]); // Writes on playload
        signal.messageReady();
        queue[finishedTaskIndex][0] = false; // Reset OnUse
        queue[finishedTaskIndex][2] = false; // Reset Solved
      }
    },

    // Process the next available task.
    nextJob: async () => {
      const taskIndex = queue.findIndex((task) =>
        task[0] && !task[1] && !task[2]
      );
      if (taskIndex !== -1) {
        queue[taskIndex][1] = true; // Lock the task
        try {
          queue[taskIndex][6] = queue[taskIndex][7] === 224
            ? await jobs[queue[taskIndex][5]][0]()
            : await jobs[queue[taskIndex][5]][0](
              queue[taskIndex][4],
            );
          queue[taskIndex][2] = true; // Mark as solved
        } finally {
          queue[taskIndex][1] = false; // Unlock the task
        }
      }
    },
    allDone: () =>
      queue.every(
        (task) => task[0] === false && task[1] === false && task[2] === false,
      ),
  };
};
