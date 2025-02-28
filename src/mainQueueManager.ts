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
  {
    promise: Promise<WorkerResponse>;
    resolve: (val: WorkerResponse) => void;
    reject: (val: unknown) => void;
  }
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

  const addDeffered = (idx: number) => {
    const promise = Promise.withResolvers<WorkerResponse>();
    promisesMap.set(idx, promise);
    return promise;
  };
  return {
    /**
     * Returns whether there are no more slots with `status == 0`.
     */
    canWrite,

    isEverythingSolve: () => status.indexOf(0) === -1,

    fastEnqueue:
      (statusSignal: StatusSignal) =>
      (functionID: FunctionID) =>
      (rawArguments: RawArguments) => {
        queue[0][0] = genTaskID();
        queue[0][1] = rawArguments;
        queue[0][2] = functionID;
        // We can potentially skip this one
        queue[0][4] = statusSignal;

        writer(queue[0]);
        setFunctionSignal(statusSignal);
        status[0] = 1;
        setSignal(192);

        return addDeffered(queue[0][0]);
      },

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

        // Deffering the prmise

        promisesMap.set(taskID, Promise.withResolvers<WorkerResponse>());

        if (idx === status.length) {
          queue.push([
            taskID,
            rawArguments,
            functionID,
            new Uint8Array(),
            statusSignal,
          ]);
          status.push(0);
          return taskID;
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
      promisesMap.get(id)?.promise
        .finally(() => promisesMap.delete(id)),

    /**
     * Await multiple tasks, remove each from PromiseMap once complete.
     */
    awaitArray: (ids: TaskID[]) => {
      return Promise.all(
        ids.map((id) =>
          promisesMap.get(id)!.promise.finally(() => promisesMap.delete(id))
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

      info!.resolve(reader());

      // Mark slot as free again
      status[idx] = -1;
    },
  };
}
