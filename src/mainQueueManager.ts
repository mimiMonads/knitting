import {
  PayloadType,
  readFromWorker,
  readPayloadError,
  readPayloadWorkerBulk,
  stringifyObjects,
  writeToShareMemory,
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
  RawArguments = 0,
  FunctionID = 1,
  WorkerResponse = 2,
  OnResolve = 3,
  OnReject = 4,
  PlayloadType = 5,
}

export enum MainListState {
  Free = 0,
  ToBeSent = 1,
  Sent = 2,
  Accepted = 3,
  Rejected = 4,
}

export type MainList = [
  unknown,
  FunctionID,
  WorkerResponse,
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

export function createMainQueue({
  signalBox: {
    status,
    functionToUse,
    queueState,
    slotIndex,
  },
  max,
  signals,
}: MultipleQueueSingle) {
  const PLACE_HOLDER = (_: void) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (main)");
  };

  const newSlot = () =>
    [
      ,
      0,
      ,
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

  // Writers
  const errorDeserializer = readPayloadError(signals);
  const write = writeToShareMemory({
    index: MainListEnum.RawArguments,
  })(signals);

  // Readers
  const blockingReader = readFromWorker(signals);
  const reader = readPayloadWorkerBulk({
    ...signals,
    specialType: "main",
  });

  // Local count
  const toBeSent: number[] = [];
  let toBeSentCount = 0;
  let inUsed = 0;

  // For FastResolving "fastCall"
  const slotZero = newSlot();

  // Helpers
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
    try {
      slotZero[MainListEnum.OnReject](reason);
    } catch {
    }

    // Reject and reset each queued task
    queue.forEach((slot, index) => {
      const reject = slot[MainListEnum.OnReject];
      if (reject !== PLACE_HOLDER) {
        try {
          reject(reason);
        } catch {
        }

        queue[index] = newSlot();
      }
    });
  };
  return {
    rejectAll,
    isThereAnythingToBeSent,
    hasEverythingBeenSent,
    fastResolveTask: () => {
      slotZero[MainListEnum.OnResolve](
        blockingReader(),
      );
    },
    fastEnqueue: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      slotZero[MainListEnum.RawArguments] = rawArgs;
      functionToUse[0] = functionID;
      write(slotZero);

      // Blocks the queue ensuring this is the only function solving
      status[0] = SignalStatus.HighPriorityResolve;

      // This functions force js to create the `Promise.withResolver` after we sent the playload
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
        slot = queue[index];

      // Checks if this is the last Element to be sent
      toBeSentCount > 0
        ? (queueState[0] = QueueStateFlag.Last)
        : (queueState[0] = QueueStateFlag.NotLast);

      write(slot);
      functionToUse[0] = slot[MainListEnum.FunctionID];
      slotIndex[0] = index;

      // Changes ownership of the sab
      status[0] = SignalStatus.MainSend;

      toBeSentCount--;
    },

    resolveError: () => {
      const index = slotIndex[0],
        slot = queue[index],
        args = errorDeserializer();

      slot[MainListEnum.OnReject](args);
      inUsed--;
      freeSockets.push(index);
    },

    /* Resolve task whose ID matches currentID */
    resolveTask: () => {
      const index = slotIndex[0], slot = queue[index], args = reader();

      slot[MainListEnum.OnResolve](
        args,
      );
      inUsed--;
      freeSockets.push(index);
      return;
    },
  };
}
