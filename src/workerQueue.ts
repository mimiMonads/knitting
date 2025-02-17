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
  {
    jobs,
    max,
    writer,
    signal: {
      getCurrentID,
      functionToUse,
      readyToRead,
      messageReady,
    },
    reader,
  }: ArgumetnsForMulti,
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
        224,
      ] as QueueList,
  );

  return {
    // Check if any task is solved and ready for writing.
    someHasFinished: () => queue.some((task) => task[0] === 2),

    // Add a task to the queue.
    add: (statusSignal: StatusSignal) => () => {
      const freeSlot = queue.find((task) => task[0] === -1);

      if (freeSlot) {
        freeSlot[0] = 0;
        freeSlot[1] = getCurrentID();
        freeSlot[2] = reader();
        freeSlot[3] = functionToUse();
        //freeSlot[4] = new Uint8Array();
        freeSlot[5] = statusSignal;
      } else {
        queue.push([
          0,
          getCurrentID(),
          reader(),
          functionToUse(),
          new Uint8Array(),
          statusSignal,
        ]);
      }

      readyToRead();
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
        task[0] = 1; // Lock the task

        try {
          task[4] = task[5] === 224
            //@ts-ignore -> Reason , 224 doesn't take any arguments
            ? await jobs[task[3]][0]()
            : await jobs[task[3]][0](
              task[2],
            );
        } finally {
          task[0] = 2; // Unlock the task
        }
      }
    },
    allDone: () =>
      queue.every(
        (task) => task[0] === -1,
      ),
  };
};
