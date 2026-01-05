import {
  readFrameBlocking,
  readFramePayload,
  readPayloadError,
  writeFramePayload,
} from "../ipc/protocol/codec.ts";
import LinkedList from "../ipc/tools/LinkList.ts";
import {
  frameFlagsFlag,
  type MainSignal,
  OP,
  type SignalArguments,
} from "../ipc/transport/shared-memory.ts";
import {
  type ComposedWithKey,
  type PromiseMap,
  PayloadType,
} from "../types.ts";
import { makeTask, TaskIndex, type Task , type Lock2 } from "../memory/lock.ts";

type RawArguments = unknown;
type WorkerResponse = unknown;
type FunctionID = number;
type QueueTask = Task;

export type MultiQueue = ReturnType<typeof createHostTxQueue>;

interface MultipleQueueSingle {
  signalBox: MainSignal;
  genTaskID: () => number;
  promisesMap: PromiseMap;

  max?: number;
  listOfFunctions: ComposedWithKey[];
  signals: SignalArguments;
  secondChannel: SignalArguments;
  lock: Lock2;
  useLock?: boolean;
}

export function createHostTxQueue({
  signalBox,
  max,
  signals,
  lock,
  useLock,
}: MultipleQueueSingle) {
  const PLACE_HOLDER = (_?: unknown) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (main)");
  };

  const {
    op,
    rpcId,
    slotIndex,
  } = signalBox;

  let countSlot = 0;

  const newSlot = () => {
    const task = makeTask() as QueueTask;
    task[TaskIndex.ID] = countSlot++;
    task[TaskIndex.FuntionID] = 0;
    task.value = undefined;
    task.payloadType = PayloadType.Undefined;
    task.resolve = PLACE_HOLDER;
    task.reject = PLACE_HOLDER;
    return task;
  };

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
    jsonString: true,
  })(signals);

  // Readers
  const blockingReader = readFrameBlocking(signals);
  const reader = readFramePayload({
    ...signals,
    specialType: "main",
  });

  // Local count
  const toBeSent = new LinkedList<QueueTask>();
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

    slotZero.resolve = deferred.resolve;
    slotZero.reject = deferred.reject;

    return deferred.promise;
  };

  const rejectAll = (reason: string) => {
    try {
      slotZero.reject(reason);
    } catch {
    }

    // Reject and reset each queued task
    queue.forEach((slot, index) => {
      if (slot.reject !== PLACE_HOLDER) {
        try {
          slot.reject(reason);
        } catch {
        }

        queue[index] = newSlot();
      }
    });
  };

  const flushToChannel = (
    frameFlags: MainSignal["frameFlags"],
    thisChannel: SignalArguments,
    checkChange: boolean,
  ) => {
    const write = writeFramePayload({
      jsonString: true,
    })({ ...thisChannel });

    const { op, slotIndex, rpcId } = thisChannel;

    return () => {
      if (checkChange === true) {
        if (toBeSent.size === 0 || op[0] !== OP.WaitingForMore) return false;
      }

      const slot = toBeSent.shift()!;

      // Checks if this is the last Element to be sent
      toBeSentCount > 0
        ? (frameFlags[0] = frameFlagsFlag.Last)
        : (frameFlags[0] = frameFlagsFlag.NotLast);

      rpcId[0] = slot[TaskIndex.FuntionID];
      slotIndex[0] = slot[TaskIndex.ID];
      write(slot);

      // Changes ownership of the sab
      op[0] = OP.MainSend;

      toBeSentCount--;
      return true;
    };
  };

  const flushToLockChannel = (
    frameFlags: MainSignal["frameFlags"],
    thisChannel: SignalArguments,
    checkChange: boolean,
  ) => {
    const { op } = thisChannel;

    return () => {
   
      if (checkChange === true) {
        if (toBeSent.size === 0 || op[0] !== OP.WaitingForMore) return false;
      }

      const slot = toBeSent.shift();
      if (!slot) return false;

      if (lock.encode(slot)) {
        toBeSent.unshift(slot);
        return false;
      }

      toBeSentCount > 0
        ? (frameFlags[0] = frameFlagsFlag.Last)
        : (frameFlags[0] = frameFlagsFlag.NotLast);

      op[0] = OP.MainSendLock;
      toBeSentCount--;
      return true;
    };
  };

  const flushToFirst = useLock === true
    ? flushToLockChannel(signalBox.frameFlags, signals, false)
    : flushToChannel(signalBox.frameFlags, signals, false);

  return {


    rejectAll,
    hasPendingFrames,
    txIdle,
    completeImmediate: () => {
      slotZero.resolve(blockingReader());
    },
    postImmediate: (functionID: FunctionID) => (rawArgs: RawArguments) => {
      if (useLock === true) {
   
        slotZero[TaskIndex.FuntionID] = functionID;
        slotZero[TaskIndex.ID] = 0;
        slotZero.value = rawArgs;
        slotZero.payloadType = PayloadType.Undefined;

        op[0] = OP.HighPriorityResolveLock;
        return addDeferred();
      }

      slotZero.value = rawArgs;
      slotZero.payloadType = PayloadType.Undefined;
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

      const index = freeSockets.pop()!;
      const slot = queue[index];
      const deferred = Promise.withResolvers<WorkerResponse>();

      // Set info
      slot.value = rawArgs;
      slot.payloadType = PayloadType.Undefined;
      slot[TaskIndex.FuntionID] = functionID;
      slot[TaskIndex.ID] = index;
      slot.resolve = deferred.resolve;
      slot.reject = deferred.reject;

      if(lock.hasSpace()){
        lock.encode(slot)
      }else{
          toBeSent.push(slot);
          toBeSentCount++;
      }

      //preRresolve(slot)
      // Change states:

      inUsed++;

      return deferred.promise;
    },

    flushToWorker: flushToFirst,

    rejectFrame: () => {
      const index = slotIndex[0];
      const args = errorDeserializer();
      const slot = queue[index];

      slot.reject(args);
      inUsed--;
      freeSockets.push(index);
    },

    /* Resolve task whose ID matches currentID */
    completeFrame: () => {
      const index = slotIndex[0];
      const args = reader();
      const slot = queue[index];

      slot.resolve(args);
      inUsed--;
      freeSockets.push(index);
      return;
    },
  };
}
