import type { QueueList } from "./mainQueueManager.ts";
import { type StatusSignal, type WorkerSignal } from "./signals.ts";

type ArgumentsForCreateWorkerQueue = {
  jobs: [Function][];
  max?: number;
  writer: (job: QueueList) => void;
  reader: () => Uint8Array;
  signal: WorkerSignal;
};

// Create and manage a working queue.
export const createWorkerQueue = (
  {
    jobs,
    max,
    writer,
    signal: {
      getCurrentID,
      functionToUse,
      messageReady,
      readyToWork,
    },
    reader,
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
      ] as QueueList,
  );

  return {
    // Check if any task is solved and ready for writing.
    someHasFinished: () => queue.some((task) => task[0] === 2),

    // enqueue a task to the queue.
    enqueue: () => {
      const freeSlot = queue.find((task) => task[0] === -1);

      if (freeSlot) {
        freeSlot[0] = 0;
        freeSlot[1] = getCurrentID();
        freeSlot[2] = reader();
        freeSlot[3] = functionToUse();
      } else {
        queue.push([
          0,
          getCurrentID(),
          reader(),
          functionToUse(),
          new Uint8Array(),
        ]);
      }

      readyToWork();
    },

    // Write completed tasks to the writer.
    write: () => {
      const finishedTaskIndex = queue.findIndex((task) => task[0] === 2);
      if (finishedTaskIndex !== -1) {
        writer(queue[finishedTaskIndex]);
        messageReady();
        queue[finishedTaskIndex][0] = -1;
      }
    },

    // Process the next available task.
    nextJob: async () => {
      const task = queue.find((task) => task[0] === 0);

      if (task !== undefined) {
        task[0] = 1;
        try {
          task[4] = await jobs[task[3]][0](
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
