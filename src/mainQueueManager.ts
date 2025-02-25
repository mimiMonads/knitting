import type { StatusSignal } from "./utils.ts";
import { type MainSignal } from "./signals.ts";

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

// PartialQueueList represents a minimal task structure for enqueueing to a queue.
export type PartialQueueList = [
  TaskID,
  RawArguments,
  FunctionID,
  StatusSignal,
];

export type PromiseMap = Map<
  TaskID,
  [
    Promise<WorkerResponse>,
    (val: WorkerResponse) => void,
    (val: unknown) => void,
  ]
>;

export type QueueList = [
  -1 | 0 | 1 | 2,
  TaskID,
  RawArguments,
  FunctionID,
  WorkerResponse,
  StatusSignal,
];

export type MultiQueue = ReturnType<typeof createMainQueue>;

interface MultipleQueueSingle {
  writer: (job: MainList) => void;
  reader: () => Uint8Array;
  signalBox: MainSignal;
  genTaskID: () => number;
  promisesMap: PromiseMap;
  max?: number;
}

/**
 * Creates the main queue manager that handles tasks on the main thread.
 */
export function createMainQueue({
  writer,
  signalBox: {
    setFunctionSignal,
    setSignal,
    getCurrentID,
    isLastElementToSend,
  },
  max,
  reader,
  genTaskID,
  promisesMap,
}: MultipleQueueSingle) {
  // The queue holds [taskID, rawArgs, functionID, workerResponse, statusSignal].
  const queue = Array.from(
    { length: max ?? 5 },
    () => [0, new Uint8Array(), 0, new Uint8Array(), 224] as MainList,
  );

  // Each element in `status` mirrors the same index in `queue`.
  // -1 => Slot free, 0 => Pending dispatch, 1 => Sent to worker, 2 => ...
  const status = Array.from({ length: max ?? 5 }, () => -1);

  /**
   * Returns `true` if there is at least one slot in `status` whose value == 0,
   * meaning "ready to be dispatched".
   */
  function canWrite(): boolean {
    return status.indexOf(0) !== -1;
  }

  return {
    /**
     * Returns whether there are no more slots with `status == 0`.
     */
    canWrite,
    isEverythingSolve: () => status.indexOf(0) === -1,

    count: () => status.length,

    /**
     * Enqueue a new task:
     *  - Finds or creates a free slot.
     *  - Registers a Promise in `promisesMap`.
     *  - Fills `queue` with the new task data.
     *  - Returns the newly generated taskID.
     */
    enqueue:
      (statusSignal: StatusSignal) =>
      (functionID: FunctionID) =>
      (rawArguments: RawArguments) => {
        const idx = status.indexOf(-1) ?? status.length,
          taskID = genTaskID();

        let resolveFn!: (res: WorkerResponse) => void,
          rejectFn!: (res: unknown) => void;

        promisesMap.set(taskID, [
          new Promise<WorkerResponse>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
          }),
          resolveFn,
          rejectFn,
        ]);

        if (idx === status.length) {
          queue.push([0, new Uint8Array(), 0, new Uint8Array(), 224]);
          status.push(-1);
        }

        // Mark slot as "Pending dispatch"
        status[idx] = 0;

        // Fill the queue record
        queue[idx][0] = taskID; // TaskID
        queue[idx][1] = rawArguments; // rawArgs
        queue[idx][2] = functionID; // functionID
        queue[idx][4] = statusSignal; // statusSignal

        return taskID;
      },

    /**
     * Await a single task ID, remove from PromiseMap once complete.
     */
    awaits: (id: TaskID) =>
      promisesMap.get(id)![0].then((result) => {
        promisesMap.delete(id);
        return result;
      }),

    /**
     * Await multiple tasks, remove each from PromiseMap once complete.
     */
    awaitArray: (ids: TaskID[]) => {
      return Promise.all(
        ids.map((id) =>
          promisesMap.get(id)![0].then((res) => {
            promisesMap.delete(id);
            return res;
          })
        ),
      );
    },

    /**
     * Move the next pending task from "Pending dispatch" to "In worker".
     * Then calls `writer(...)` to actually transfer the data to the worker thread.
     */
    dispatchToWorker: () => {
      const idx = status.indexOf(0);

      // Mark this slot as "Sent to worker"
      status[idx] = 1;

      // Let the mainSignal know whether there's still something to send
      isLastElementToSend(canWrite());

      // Actually send the job out
      writer(queue[idx]);
      setFunctionSignal(queue[idx][2]);
      setSignal(queue[idx][4]);
    },

    /**
     * Completes a task (resolves its Promise) once the worker finishes.
     * Looks up the relevant queue slot by `currentID`, reads the worker output,
     * and resolves the stored promise.
     */
    resolveTask: () => {
      const currentID = getCurrentID(),
        // Potentially slow to search
        idx = queue.findIndex((item) => item[0] === currentID),
        info = promisesMap.get(queue[idx][0]);

      info![1](reader());

      // Mark slot as free again
      status[idx] = -1;
    },
  };
}
