import {
  PayloadType,
  preencodeJsonString,
  readFrameBlocking,
  readFramePayload,
  readPayloadError,
  writeFramePayload,
} from "../ipc/protocol/codec.ts";
import {
  frameFlagsFlag,
  type MainSignal,
  OP,
  type SignalArguments,
} from "../ipc/transport/shared-memory.ts";
import type { ComposedWithKey } from "../types.ts";

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
  PayloadType = 5,
  slotIndex = 6,
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
  number,
];

export type QueueListWorker = MainList;

export type MultiQueue = ReturnType<typeof createHostTxQueue>;

interface MultipleQueueSingle {
  signalBox: MainSignal;
  genTaskID: () => number;
  promisesMap: PromiseMap;

  max?: number;
  listOfFunctions: ComposedWithKey[];
  signals: SignalArguments;
  secondChannel:  SignalArguments
}

export function createHostTxQueue({
  signalBox,
  max,
  signals,
  secondChannel
}: MultipleQueueSingle) {
  const PLACE_HOLDER = (_: void) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (main)");
  };

  const {
    op,
    rxStatus,
    rpcId,
    frameFlags,
    slotIndex,
  } = signalBox;

  let countSlot = 0;
  const newSlot = () =>
    [
      ,
      0,
      ,
      PLACE_HOLDER,
      PLACE_HOLDER,
      PayloadType.Undefined,
      countSlot++,
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
  const write = writeFramePayload({
    index: MainListEnum.RawArguments,
    jsonString: true,
  })(signals);

  // Readers
  const blockingReader = readFrameBlocking(signals);
  const reader = readFramePayload({
    ...signals,
    specialType: "main",
  });

  const simplifies = preencodeJsonString({
    index: MainListEnum.RawArguments,
  });

  // Local count
  const toBeSent: number[] = [];
  let toBeSentCount = 0;
  let inUsed = 0;

  // For FastResolving "fastCall"
  const slotZero = newSlot();

  // Helpers
  const hasPendingFrames = () => toBeSentCount > 0;
  const txIdle = () => toBeSentCount === 0 && inUsed === 0;
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

  const flushToChannel = (
    frameFlags: MainSignal['frameFlags'],
    thisChannel: SignalArguments,
    checkChange: boolean,
  ) => {
 
    const write = writeFramePayload({
      index: MainListEnum.RawArguments,
      jsonString: true,
    })({...thisChannel});

    const { op, slotIndex, rpcId } = thisChannel;

    return () => {
      if (checkChange === true) {
        if (toBeSent.length === 0 || op[0] !== OP.WaitingForMore) return false;
      }

      const index = toBeSent.pop()!,
        slot = queue[index];

      // Checks if this is the last Element to be sent
      toBeSentCount > 0
        ? (frameFlags[0] = frameFlagsFlag.Last)
        : (frameFlags[0] = frameFlagsFlag.NotLast);

      rpcId[0] = slot[MainListEnum.FunctionID];
      slotIndex[0] = index;
      write(slot);

      // Changes ownership of the sab
      op[0] = OP.MainSend;

      toBeSentCount--;
      return true;
    };
  };

  const flushToFirst = flushToChannel(signalBox.frameFlags, signals, false)

  return {
    optimizeQueue: () => {
      let i = 0;

      while (rxStatus[0] === 1 && toBeSent.length > i) {
        simplifies(queue[toBeSent[i]]);
        i++;
      }
    },

    rejectAll,
    hasPendingFrames,
    txIdle,
    completeImmediate: () => {
      slotZero[MainListEnum.OnResolve](
        blockingReader(),
      );
    },
    postImmediate: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      slotZero[MainListEnum.RawArguments] = rawArgs;
      rpcId[0] = functionID;
      write(slotZero);

      // Blocks the queue ensuring this is the only function solving
      op[0] = OP.HighPriorityResolve;

      // This functions force js to create the `Promise.withResolver` after we sent the playload
      return addDeferred();
    },

    /* General enqueue with promise */
    enqueue: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      // Expanding size if needed
      if (inUsed === queue.length) {
        const newSize = inUsed + 10;
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

      //preRresolve(slot)
      // Change states:
      toBeSent.push(index);
      toBeSentCount++;
      inUsed++;

      return deferred.promise;
    },

    flushToWorker: flushToFirst,

    rejectFrame: () => {
      const index = slotIndex[0],
        slot = queue[index],
        args = errorDeserializer();

      slot[MainListEnum.OnReject](args);
      inUsed--;
      freeSockets.push(index);
    },

    /* Resolve task whose ID matches currentID */
    completeFrame: () => {
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
