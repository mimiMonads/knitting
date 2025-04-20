import { readFromWorker, sendToWorker } from "./parsers.ts";
import { type MainSignal, type SignalArguments } from "./signals.ts";
import type { ComposedWithKey } from "./taskApi.ts";
import type { Serializable } from "./taskApi.ts";

// Task ID is a unique number representing a task.
type TaskID = number;
// RawArguments are optional arguments in the form of a Uint8Array.
type RawArguments<T extends Serializable = Uint8Array> = T;
// WorkerResponse is the result of a task, represented as a Uint8Array.
type WorkerResponse<T extends Serializable = Uint8Array> = T;
// FunctionID represents a unique identifier for a function to execute.
type FunctionID = number;

export type PromiseMap = Map<
  TaskID,
  {
    promise: Promise<WorkerResponse>;
    resolve: (val: WorkerResponse) => void;
    reject: (val: unknown) => void;
  }
>;

export type MainList<A = Uint8Array, B = Uint8Array> = [
  TaskID,
  RawArguments,
  FunctionID,
  WorkerResponse,
  -1 | 0 | 1 | 2,
];

export type QueueListWorker = MainList;

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
 * queue[i][4] encodes slot status:
 *   -1 free • 0 pending dispatch • 1 sent to worker • 2 ready to resolve
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
  /*───────────────────────────────  Queue  ───────────────────────────────*/
  const queue = Array.from(
    { length: max ?? 5 },
    () => [0, new Uint8Array(), 0, new Uint8Array(), -1] as MainList,
  );

  const sendToWorkerWithSignal = sendToWorker(signals);
  const readFromWorkerWithSignal = readFromWorker(signals);

  const sendToWokerArray = listOfFunctions.map((fix) =>
    sendToWorkerWithSignal( //@ts-ignore
      fix.args ?? "serializable",
    )
  );

  const readFromWorkerArray = listOfFunctions.map((fix) =>
    readFromWorkerWithSignal( //@ts-ignore
      fix.return ?? "serializable",
    )
  );

  /*────────────────────────────── Helpers ────────────────────────────────*/
  function canWrite(): boolean {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i][4] === 0) return true;
    }
    return false;
  }

  function isEverythingSolve(): boolean {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i][4] === 0) return false;
    }
    return true;
  }

  function addDeferred(taskID: number) {
    const deferred = Promise.withResolvers<WorkerResponse>();
    promisesMap.set(taskID, deferred);
    return deferred.promise.finally(() => promisesMap.delete(taskID));
  }

  const rejectAll = (reason: string) => {
    promisesMap.forEach((def) => def.reject(reason));
  };

  /*──────────────────────────────  API  ───────────────────────────────*/
  return {
    rejectAll,
    canWrite,
    isEverythingSolve,

    /* Fast path (always queue[0]) */
    fastEnqueue: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      const slot = queue[0];

      slot[0] = genTaskID();
      slot[1] = rawArgs;
      slot[2] = functionID;

      sendToWokerArray[0](slot);
      setFunctionSignal(functionID);
      isLastElementToSend(false);
      send();
      slot[4] = 1;
      return addDeferred(slot[0]);
    },

    /* General enqueue with promise */
    enqueuePromise: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      let idx = -1;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === -1) {
          idx = i;
          break;
        }
      }

      const taskID = genTaskID();
      const deferred = Promise.withResolvers<WorkerResponse>();
      promisesMap.set(taskID, deferred);

      if (idx === -1) {
        queue.push([
          taskID,
          rawArgs,
          functionID,
          new Uint8Array(),
          0,
        ]);
      } else {
        const slot = queue[idx];
        slot[0] = taskID;
        slot[1] = rawArgs;
        slot[2] = functionID;
        slot[4] = 0;
      }

      return deferred.promise.finally(() => promisesMap.delete(taskID));
    },

    count: () => queue.length,

    /* Dispatch first pending (status==0) */
    dispatchToWorker: () => {
      let idx = -1;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][4] === 0) {
          idx = i;
          break;
        }
      }

      const job = queue[idx];
      job[4] = 1; // sent to worker

      isLastElementToSend(canWrite());
      sendToWokerArray[job[2]](job);
      setFunctionSignal(job[2]);
      send();
    },

    /* Resolve task whose ID matches currentID */
    resolveTask: () => {
      const currentID = getCurrentID();
      let idx = -1;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][0] === currentID) {
          idx = i;
          break;
        }
      }

      const job = queue[idx];
      const promiseEntry = promisesMap.get(job[0]);
      promiseEntry?.resolve( //@ts-ignore
        readFromWorkerArray[job[2]](),
      );

      job[4] = -1; // slot free
    },
  };
}
