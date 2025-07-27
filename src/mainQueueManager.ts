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
  },
  max,
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
        PayloadType.Undefined,
      ] as MainList,
  );

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
      slotZero[MainListEnum.State] = MainListState.Free;
    },
    /* Fast path (always queue[0]) */
    fastEnqueue: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      slotZero[MainListEnum.TaskID] = genID++;
      slotZero[MainListEnum.RawArguments] = rawArgs;
      slotZero[MainListEnum.FunctionID] = functionID;
      sendToWokerArray[0](slotZero);
      functionToUse[0] = functionID;
      status[0] = SignalStatus.HighPriotityResolve;
      slotZero[MainListEnum.State] = MainListState.Sent;

      return addDeferred();
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

      const deferred = Promise.withResolvers<WorkerResponse>();
      toBeSentCount++;

      if (idx !== -1) {
        const slot = queue[idx];
        slot[MainListEnum.TaskID] = genID++;
        slot[MainListEnum.RawArguments] = rawArgs;
        slot[MainListEnum.FunctionID] = functionID;
        slot[MainListEnum.State] = MainListState.ToBeSent;
        slot[MainListEnum.OnResolve] = deferred.resolve;
        slot[MainListEnum.OnReject] = deferred.reject;
      } else {
        queue.push([
          genID++,
          rawArgs,
          functionID,
          new Uint8Array(),
          MainListState.ToBeSent,
          deferred.resolve,
          deferred.reject,
          PayloadType.Undefined,
        ]);
      }

      return deferred.promise;
    },
    /* Dispatch first pending (status==0) */
    dispatchToWorker: () => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.State] === MainListState.ToBeSent) {
          const job = queue[i];
          job[MainListEnum.State] = MainListState.Sent;
          toBeSentCount > 0
            ? (queueState[0] = QueueStateFlag.Last)
            : (queueState[0] = QueueStateFlag.NotLast),
            sendToWokerArray[job[MainListEnum.FunctionID]](job);
          functionToUse[0] = job[MainListEnum.FunctionID];
          status[0] = SignalStatus.MainSend;
          toBeSentCount--;
          break;
        }
      }
    },

    resolveError: () => {
      const currentID = id[0];

      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.TaskID] === currentID) {
          const slot = queue[i];
          slot[MainListEnum.OnReject](errorDeserializer());
          slot[MainListEnum.State] = MainListState.Free;
          break;
        }
      }
    },

    /* Resolve task whose ID matches currentID */
    resolveTask: () => {
      const currentID = id[0], args = reader();

      for (let i = 0; i < queue.length; i++) {
        if (queue[i][MainListEnum.TaskID] === currentID) {
          const job = queue[i];
          job[MainListEnum.OnResolve](
            args,
          );
          job[MainListEnum.State] = MainListState.Free;
          return;
        }
      }
    },
  };
}
