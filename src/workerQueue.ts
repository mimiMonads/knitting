import type { QueueList } from "./mainQueue.ts";
import { type StatusSignal, type WorkerSignal } from "./signal.ts";

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
    { length: max ?? 3 },
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
      const freeSlot = queue.find((task) => !task[0]);

      if (freeSlot) {
        freeSlot[0] = true;
        freeSlot[3] = signal.getCurrentID();
        freeSlot[4] = reader();
        freeSlot[5] = signal.functionToUse();
        freeSlot[7] = statusSignal;
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
      const task = queue.find((task) => task[0] && !task[1] && !task[2]);
      if (task !== undefined) {
        task[1] = true; // Lock the task
        try {
          task[6] = task[7] === 224
            //@ts-ignore -> Reason , 224 doesn't take any arguments
            ? await jobs[task[5][0]]()
            : await jobs[task[5]][0](
              task[4],
            );
          task[2] = true; // Mark as solved
        } finally {
          task[1] = false; // Unlock the task
        }
      }
    },
    allDone: () =>
      queue.every(
        (task) => task[0] === false,
      ),
  };
};
