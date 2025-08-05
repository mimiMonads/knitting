import {
  PayloadType,
  readFromWorker,
  readPayloadError,
  readPayloadWorkerBulk,
  sendToWorker,
} from "./parsers.ts";
import {
  type MainSignal,
  QueueStateFlag,
  type SignalArguments,
  SignalStatus,
} from "./signals.ts";
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
  PlayloadType = 7,
}

export enum MainListState {
  Free = 0,
  ToBeSent = 1,
  Sent = 2,
  Accepted = 3,
  Rejected = 4,
}

export type MainList = [
  number,
  unknown,
  FunctionID,
  WorkerResponse,
  MainListState,
  Accepted,
  Rejected,
  PayloadType,
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
    status,
    functionToUse,
    id,
    queueState,
    slotIndex,
  },
  max,
  promisesMap,
  listOfFunctions,
  signals,
}: MultipleQueueSingle) {
  /*───────────────────────────────  Queue  ───────────────────────────────*/

  const PLACE_HOLDER = (_: void) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (main)");
  };

  const newSlot = () =>
    [
      0,
      ,
      0,
      ,
      MainListState.Free,
      PLACE_HOLDER,
      PLACE_HOLDER,
      PayloadType.Undefined,
    ] as MainList;

  const queue = Array.from(
    { length: max ?? 10 },
    newSlot,
  );

  const freeSockets = Array.from(
    { length: max ?? 10 },
    (_, i) => i,
  );

  const toBeSent: number[] = [];

  const reader = readPayloadWorkerBulk({
    ...signals,
    specialType: "main",
  });
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

  let genID = 0;
  let toBeSentCount = 0;
  let inUsed = 0;

  const slotZero = queue[0];
  const isThereAnythingToBeSent = () => toBeSentCount > 0;
  const hasEverythingBeenSent = () => toBeSentCount === 0;
  const addDeferred = () => {
    const deferred = Promise.withResolvers<
      WorkerResponse
    >();

    slotZero[MainListEnum.OnResolve] = deferred.resolve;
    slotZero[MainListEnum.OnReject] = deferred.reject;

    return deferred.promise;
  };

  const rejectAll = (reason: string) => {
    promisesMap.forEach((def) => def.reject(reason));
  };

  return {
    rejectAll,
    isThereAnythingToBeSent,
    hasEverythingBeenSent,
    fastResolveTask: () => {
      slotZero[MainListEnum.OnResolve](
        readFromWorkerArray[slotZero[MainListEnum.FunctionID]](),
      );
    },

    fastEnqueue: (functionID: FunctionID) => (rawArgs: RawArguments) => {
     
      slotZero[MainListEnum.RawArguments] = rawArgs;
      slotZero[MainListEnum.FunctionID] = functionID;
      sendToWokerArray[0](slotZero);
      functionToUse[0] = functionID;

      // Blocks the queue ensuring this is the only function solving
      status[0] = SignalStatus.HighPriotityResolve;

      return addDeferred();
    },

    /* General enqueue with promise */
    enqueuePromise: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      // Expanding size if needed
      if (inUsed === queue.length) {
        const newSize = inUsed + 50;
        let current = queue.length;

        while (newSize > current) {
          queue.push(newSlot());
          freeSockets.push(current);
          current++;
        }
      }

      const index = freeSockets.pop()!,
        slot = queue[index],
        deferred = Promise.withResolvers<WorkerResponse>();

      // Set info
      slot[MainListEnum.TaskID] = genID++;
      slot[MainListEnum.RawArguments] = rawArgs;
      slot[MainListEnum.FunctionID] = functionID;
      slot[MainListEnum.OnResolve] = deferred.resolve;
      slot[MainListEnum.OnReject] = deferred.reject;

      // Change states:
      toBeSent.push(index);
      toBeSentCount++;
      inUsed++;

      return deferred.promise;
    },

    dispatchToWorker: () => {
      const index = toBeSent.pop()!,
        job = queue[index];

      // Checks if this is the last Element to be sent
      toBeSentCount > 0
        ? (queueState[0] = QueueStateFlag.Last)
        : (queueState[0] = QueueStateFlag.NotLast);

      sendToWokerArray[job[MainListEnum.FunctionID]](job);
      functionToUse[0] = job[MainListEnum.FunctionID];
      slotIndex[0] = index;

      // Changes ownership of the sab
      status[0] = SignalStatus.MainSend;

      toBeSentCount--;
    },

    resolveError: () => {
      const currentID = id[0], index = slotIndex[0];

      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.TaskID] === currentID) {
          const slot = queue[i];
          slot[MainListEnum.OnReject](errorDeserializer());
          inUsed--;
          freeSockets.push(index);
          break;
        }
      }
    },

    /* Resolve task whose ID matches currentID */
    resolveTask: () => {
      const index = slotIndex[0], job = queue[index], args = reader();

      job[MainListEnum.OnResolve](
        args,
      );
      inUsed--;
      freeSockets.push(index);
      return;
    },
  };
}
