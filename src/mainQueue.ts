// Type Definitions

import type { StatusSignal } from "./helpers.ts";
import { type MainSignal } from "./signal.ts";

// Task ID is a unique number representing a task.
type TaskID = number;
// RawArguments are optional arguments in the form of a Uint8Array.
type RawArguments = Uint8Array;
// WorkerResponse is the result of a task, represented as a Uint8Array.
type WorkerResponse = Uint8Array;
// FunctionID represents a unique identifier for a function to execute.
type FunctionID = number;

// MainList represents tasks in the main thread.
export type MainList = [
  TaskID,
  RawArguments,
  FunctionID,
  WorkerResponse,
  StatusSignal,
];

// PartialQueueList represents a minimal task structure for adding to a queue.
export type PartialQueueList = [
  TaskID,
  RawArguments,
  FunctionID,
  StatusSignal,
];

export type PromiseMap = Map<
  TaskID,
  [Promise<WorkerResponse>, (val: WorkerResponse) => void]
>;

export type QueueList = [
  -1 | 0 | 1 | 2,
  TaskID,
  RawArguments,
  FunctionID,
  WorkerResponse,
  StatusSignal,
];

export type MultiQueue = ReturnType<typeof multi>;

type MultipleQueueSingle = {
  writer: (job: MainList) => void;
  reader: () => Uint8Array;
  signalBox: MainSignal;
  genTaskID: () => number;
  promisesMap: PromiseMap;
  max?: number;
};
export const multi = (
  {
    writer,
    signalBox: {
      setFunctionSignal,
      setSignal,
      getCurrentID,
    },
    max,
    reader,
    genTaskID,
    promisesMap,
  }: MultipleQueueSingle,
) => {
  const queue = Array.from(
    { length: max ?? 4 },
    () =>
      [
        0,
        new Uint8Array(),
        0,
        new Uint8Array(),
        224,
      ] as MainList,
  );

  const status = Array.from(
    { length: max ?? 4 },
    (_, i) => -1,
  );

  return {
    canWrite: () => status.indexOf(0) !== -1,

    isEverythingSolve: () => status.indexOf(0) === -1,

    count: () => status.length,

    add:
      (statusSignal: StatusSignal) =>
      (functionID: FunctionID) =>
      (rawArguments: RawArguments) => {
        const freeIndex = status.indexOf(-1),
          taskID = genTaskID();
        let resolveFn!: (res: WorkerResponse) => void;

        if (freeIndex === -1) {
          throw "No free slots! isBusyFailed uwu";
        }

        // Store the Promise + resolver in our Map
        promisesMap.set(taskID, [
          new Promise<WorkerResponse>((resolve) => {
            resolveFn = resolve;
          }),
          resolveFn,
        ]);

        status[freeIndex] = 0;

        queue[freeIndex][0] = taskID;
        queue[freeIndex][1] = rawArguments;
        queue[freeIndex][2] = functionID;
        queue[freeIndex][4] = statusSignal;

        return taskID;
      },

    /**
     * awaits: returns the same Promise that was created in `add`.
     * If the task was never added or has already been cleaned up,
     * it rejects (or you can choose to return a resolved Promise).
     */
    awaits: (id: TaskID) =>
      promisesMap.get(id)![0].then((x) => {
        promisesMap.delete(id);
        return x;
      }),
    awaitArray: (ids: TaskID[]) => {
      return Promise.all(
        ids.map((id) =>
          promisesMap.get(id)![0].then((x) => {
            promisesMap.delete(id);
            return x;
          })
        ),
      );
    },

    sendNextToWorker: () => {
      const idx = status.indexOf(0);

      if (idx === -1) {
        throw "xd somethin whent wrong in sendNextToWorker";
      }

      writer(queue[idx]);
      setFunctionSignal(queue[idx][2]);
      setSignal(queue[idx][4]);
    },
    solve: () => {
      const currentID = getCurrentID();
      // Slow opetation
      const idx = queue.findIndex((item) => item[0] === currentID);

      if (idx === -1) {
        throw "solve couldn't find " + currentID;
      }

      const info = promisesMap.get(queue[idx][0]);
      if (info) {
        // Resolves the promise
        info[1](reader());
      } else {
        throw currentID + "was not found";
      }

      status[idx] = -1;
    },
  };
};
