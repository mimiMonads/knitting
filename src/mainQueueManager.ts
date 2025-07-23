import { readFromWorker, readPayloadError, sendToWorker } from "./parsers.ts";
import { type MainSignal, type SignalArguments } from "./signals.ts";
import type { ComposedWithKey } from "./taskApi.ts";

type RawArguments = unknown;
type WorkerResponse = unknown;
type FunctionID = number;
type Accepted = (val: unknown) => void;
type Rejected = (val: unknown) => void;

export type PromiseMap = Map<
  number,
  {
    promise: Promise<unknown>;
    resolve: Accepted;
    reject: Rejected;
  }
>;


export enum MainListEnum {
  // Task ID is a unique number representing a task.
  TaskID = 0,
  RawArguments = 1,
  FunctionID = 2,
  WorkerResponse = 3,
  State = 4,
  OnResolve = 5,
  OnReject = 6,
}

export enum MainListState {
  Free = -1,
  ToBeSent = 0,
  Sent = 1,
  Accepted = 2,
  Rejected = 3,
}

export type MainList = [
  number,
  unknown,
  FunctionID,
  WorkerResponse,
  MainListState,
  Accepted,
  Rejected,
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

  const PLACE_HOLDER = (_) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (main)");
  };

  const queue = Array.from(
    { length: max ?? 5 },
    () =>
      [
        0,
        new Uint8Array(),
        0,
        new Uint8Array(),
        -1,
        PLACE_HOLDER,
        PLACE_HOLDER,
      ] as MainList,
  );

  const sendToWorkerWithSignal = sendToWorker(signals);
  const readFromWorkerWithSignal = readFromWorker(signals);
  const errorDeserializer = readPayloadError(signals);

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

  function canWrite(): boolean {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i][MainListEnum.State] === MainListState.ToBeSent) return true;
    }

    return false;
  }

  function isEverythingSolved(): boolean {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i][MainListEnum.State] === MainListState.ToBeSent) return false;
    }
    return true;
  }

  function addDeferred(taskID: number) {
    const { promise, resolve, reject } = Promise.withResolvers<
        WorkerResponse
      >(),
      task = queue[0];

    task[MainListEnum.OnResolve] = resolve;
    task[MainListEnum.OnReject] = reject;

    promisesMap.set(taskID, {
      promise,
      resolve,
      reject,
    });

    return promise.finally(() => promisesMap.delete(taskID));
  }

  const rejectAll = (reason: string) => {
    promisesMap.forEach((def) => def.reject(reason));
  };

  return {
    rejectAll,
    canWrite,
    isEverythingSolved,

    /* Fast path (always queue[0]) */
    fastEnqueue: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      const slot = queue[0];

      slot[MainListEnum.TaskID] = genTaskID();
      slot[MainListEnum.RawArguments] = rawArgs;
      slot[MainListEnum.FunctionID] = functionID;

      sendToWokerArray[0](slot);
      setFunctionSignal(functionID);
      isLastElementToSend(false);
      send();
      slot[MainListEnum.State] = MainListState.Sent;

      return addDeferred(slot[0]);
    },

    /* General enqueue with promise */
    enqueuePromise: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      let idx = -1;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.State] === MainListState.Free) {
          idx = i;
          break;
        }
      }

      const taskID = genTaskID();
      const deferred = Promise.withResolvers<WorkerResponse>();
      promisesMap.set(taskID, deferred);

      if (idx !== -1) {
        const slot = queue[idx];
        slot[MainListEnum.TaskID] = taskID;
        slot[MainListEnum.RawArguments] = rawArgs;
        slot[MainListEnum.FunctionID] = functionID;
        slot[MainListEnum.State] = MainListState.ToBeSent;
        slot[MainListEnum.OnResolve] = deferred.resolve
        slot[MainListEnum.OnReject] =  deferred.reject
      } else {
        queue.push([
          taskID,
          rawArgs,
          functionID,
          new Uint8Array(),
          MainListState.ToBeSent,
          deferred.resolve,
          deferred.reject,
        ]);
      }

      return deferred.promise.finally(() => promisesMap.delete(taskID));
    },

    count: () => queue.length,

    /* Dispatch first pending (status==0) */
    dispatchToWorker: () => {
      let idx = -1;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.State] === MainListState.ToBeSent) {
          idx = i;
          break;
        }
      }

      const job = queue[idx];
      job[MainListEnum.State] = MainListState.Sent; 

      isLastElementToSend(canWrite());
      sendToWokerArray[job[MainListEnum.FunctionID]](job);
      setFunctionSignal(job[MainListEnum.FunctionID]);
      send();
    },

    resolveError: () => {
      const currentID = getCurrentID();
      let idx = -1;

      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.TaskID] === currentID) {
          idx = i;
          break;
        }
      }

      const slot = queue[idx];
      const promiseEntry = promisesMap.get(slot[MainListEnum.TaskID]);

      promiseEntry?.reject( 
        errorDeserializer(),
      );

      slot[MainListEnum.State] = MainListState.Free; 
    },

    /* Resolve task whose ID matches currentID */
    resolveTask: () => {
      const currentID = getCurrentID();
      let idx = -1;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.TaskID] === currentID) {
          idx = i;
          break;
        }
      }

      const job = queue[idx];
      const promiseEntry = promisesMap.get(currentID);

      promiseEntry?.resolve( 
        readFromWorkerArray[job[MainListEnum.FunctionID]](),
      );

      job[MainListEnum.State] = MainListState.Free; 
    },
  };
}
