import { readFromWorker, sendToWorker } from "./parsers.ts";
import { type MainSignal, type SignalArguments } from "./signals.ts";
import type { ComposedWithKey } from "./taskApi.ts";

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
];

// PartialQueueListWorker represents a minimal task structure for enqueueing to a queue.
export type PartialQueueListWorker = [
  TaskID,
  RawArguments,
  FunctionID,
];

export type PromiseMap = Map<
  TaskID,
  {
    promise: Promise<WorkerResponse>;
    resolve: (val: WorkerResponse) => void;
    reject: (val: unknown) => void;
  }
>;

export type QueueListWorker = [
  -1 | 0 | 1 | 2,
  TaskID,
  RawArguments,
  FunctionID,
  WorkerResponse,
];

export type MultiQueue = ReturnType<typeof createMainQueue>;

interface MultipleQueueSingle {
  signalBox: MainSignal;
  genTaskID: () => number;
  promisesMap: PromiseMap;
  max?: number;
  listOfFunctions: ComposedWithKey[];
  signals: SignalArguments;
}

/**
 * Creates the main queue manager that handles tasks on the main thread.
 */
export function createMainQueue({
  signalBox: {
    setFunctionSignal,
    getCurrentID,
    isLastElementToSend,
    send,
  },
  max,
  genTaskID,
  promisesMap,
  listOfFunctions,
  signals,
}: MultipleQueueSingle) {
  // The queue holds [taskID, rawArgs, functionID, workerResponse, statusSignal].
  const queue = Array.from(
    { length: max ?? 5 },
    () => [0, new Uint8Array(), 0, new Uint8Array()] as MainList,
  );

  const sendToWorkerWithSignal = sendToWorker(
    signals,
  );

  const readFromWorkerWithSignal = readFromWorker(
    signals,
  );

  //Parses the information to be sent to the worker
  const sendToWokerArray = listOfFunctions.reduce(
    (acc, fixpoint) => (acc.push(sendToWorkerWithSignal(
      //@ts-ignore
      fixpoint.args ?? "serializable",
    )),
      acc),
    [] as ((arg: any) => any)[],
  );

  //Parses the information to be sent to the worker
  const readFromWorkerArray = listOfFunctions.reduce(
    (acc, fixpoint) => (acc.push(readFromWorkerWithSignal(
      //@ts-ignore
      fixpoint.return ?? "serializable",
    )),
      acc),
    [] as ((arg: any) => any)[],
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

  const rejectAll = (reason: string) => {
    promisesMap.forEach(
      (deferred) => deferred.reject(reason),
    );
  };

  const adddeferred = (idx: number) => {
    const deferred = Promise.withResolvers<WorkerResponse>();

    promisesMap.set(idx, deferred);

    // Finally returns the promise
    return deferred.promise.finally(() => promisesMap.delete(0));
  };

  return {
    /**
     * Rejects all the promises with a reason, this function is used to close a thread
     * ensuring that all promises were resolved
     */
    rejectAll,
    /**
     * Returns whether there are no more slots with `status == 0`.
     */
    canWrite,

    isEverythingSolve: () => status.indexOf(0) === -1,

    fastEnqueue: (functionID: FunctionID) => (rawArguments: RawArguments) => {
      queue[0][0] = genTaskID();
      queue[0][1] = rawArguments;
      queue[0][2] = functionID;

      sendToWokerArray[0](queue[0]);
      //writer(queue[0]);
      setFunctionSignal(functionID);
      status[0] = 1;
      isLastElementToSend(false);

      send();

      return adddeferred(queue[0][0]);
    },

    enqueuePromise:
      (functionID: FunctionID) => (rawArguments: RawArguments) => {
        const idx = status.indexOf(-1) ?? status.length,
          taskID = genTaskID(),
          deferred = Promise.withResolvers<WorkerResponse>();

        promisesMap.set(taskID, deferred);

        if (idx === status.length) {
          queue.push([
            taskID,
            rawArguments,
            functionID,
            new Uint8Array(),
          ]);
          status.push(0);
          return deferred
            .promise.finally(() => promisesMap.delete(taskID));
        }

        // Mark slot as "Pending dispatch"
        status[idx] = 0;

        // Fill the queue record
        queue[idx][0] = taskID; // TaskID
        queue[idx][1] = rawArguments; // rawArgs
        queue[idx][2] = functionID; // functionID

        return deferred.promise.finally(() => promisesMap.delete(taskID));
      },

    count: () => status.length,
    /**
     * Move the next pending task from "Pending dispatch" to "In worker".
     * Then calls `writer(...)` to actually transfer the data to the worker thread.
     */
    dispatchToWorker: () => {
      const idx = status.indexOf(0), queueElement = queue[idx];

      // Mark this slot as "Sent to worker"
      status[idx] = 1;

      // Let the mainSignal know whether there's still something to send
      isLastElementToSend(canWrite());

      // Actually send the job out
      sendToWokerArray[queueElement[2]](queueElement);

      setFunctionSignal(queueElement[2]);
      send();
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

      info?.resolve(
        //@ts-ignore
        readFromWorkerArray[queue[idx][2]](),
      );

      // Mark slot as free again
      status[idx] = -1;
    },
  };
}
