import RingQueue from "../ipc/tools/RingQueue.ts";
import { decodePayload, encodePayload } from "./payloadCodec.ts";
import { createSharedArrayBuffer } from "../common/runtime.ts";
import { register } from "./regionRegistry.ts";
import {
  resolvePayloadBufferOptions,
  type PayloadBufferOptions,
} from "./payload-config.ts";


/**
 * TODO: Compose all the instance where the array is passed as argument
 * 
 * 
 */

 export enum PayloadSignal {
  UNREACHABLE = 0,
  BigInt = 2,
  True = 3,
  False = 4,
  Undefined = 5,
  NaN = 6,

  Float64 = 9,
  Null = 10,
}



export enum PayloadBuffer {
  BORDER_SIGNAL_BUFFER = 11,
  String = 11,
  Json = 12,
  StaticString = 15,
  StaticJson = 16,
  Binary = 17,
  StaticBinary = 18,
  Int32Array = 19,
  Float64Array = 20,
  BigInt64Array = 21,
  BigUint64Array = 22,
  DataView = 23,
  Error = 24,
  Date = 25,
  Symbol = 26,
  StaticSymbol = 27,
  BigInt = 28,
  StaticBigInt = 29,
  StaticInt32Array = 31,
  StaticFloat64Array = 32,
  StaticBigInt64Array = 33,
  StaticBigUint64Array = 34,
  StaticDataView = 35,
  ArrayBuffer = 36,
  StaticArrayBuffer = 37,
  Buffer = 38,
  StaticBuffer = 39,
  EnvelopeStaticHeader = 40,
  EnvelopeDynamicHeader = 41,
}



export enum LockBound {
  paddingLock = 0,
  padding = 0,
  slots = 32,
  header = 0,
}

export const LOCK_CACHE_LINE_BYTES = 64;
export const LOCK_SECTOR_BYTES = 256;

export type Task = [
  number,
  number,
  PayloadSignal | PayloadBuffer,
  number,
  number,
  number, 
  number,
  number,
] & {
  value: unknown;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
};

export const PromisePayloadMarker = Symbol.for("knitting.promise.payload");
export const PromisePayloadHandlerSymbol = Symbol.for(
  "knitting.promise.payload.handler",
);
export const PromisePayloadStatusSymbol = Symbol.for(
  "knitting.promise.payload.status",
);
export const PromisePayloadResultSymbol = Symbol.for(
  "knitting.promise.payload.result",
);
export const PromisePayloadFulfillSymbol = Symbol.for(
  "knitting.promise.payload.fulfill",
);
export const PromisePayloadRejectSymbol = Symbol.for(
  "knitting.promise.payload.reject",
);

export const enum PromisePayloadStatus {
  Idle = 0,
  Fulfilled = 1,
  Rejected = 2,
}

export type PromisePayloadResult = {
  status: "fulfilled" | "rejected";
  value: unknown;
  reason: unknown;
};

export type PromisePayloadHandler = (
  task: Task,
  result: PromisePayloadResult,
) => void;

export const getPromisePayloadStatus = (task: Task): PromisePayloadStatus =>
  (task as Task & {
    [PromisePayloadStatusSymbol]?: PromisePayloadStatus;
  })[PromisePayloadStatusSymbol] ?? PromisePayloadStatus.Idle;

export const getPromisePayloadResult = (task: Task): PromisePayloadResult =>
  (task as Task & {
    [PromisePayloadResultSymbol]?: PromisePayloadResult;
  })[PromisePayloadResultSymbol]!;

export enum TaskIndex {
  /**
   * Worker -> host response flags word.
   */
  FlagsToHost = 0,
  /**
   * Host -> worker request function id (low 16 bits).
   * High 16 bits are reserved for caller metadata on request path.
   * NOTE: shares the same storage word as `FlagsToHost`.
   */
  FunctionID = 0,
  ID = 1,
  Type = 2,
  Start = 3,
  End = 4,
  PayloadLen = 5,
  /**
   * Low 5 bits: region slot index (0..31).
   * High 27 bits: reserved for caller metadata (e.g. enqueue timing).
   */
  slotBuffer = 6,
  Size = 8,
  /**
   * Total slot length in Uint32 words, including the task header.
   */
  TotalBuff = 144,
}

export const TASK_SLOT_INDEX_BITS = 5;
export const TASK_SLOT_INDEX_MASK = (1 << TASK_SLOT_INDEX_BITS) - 1;
export const TASK_SLOT_META_BITS = 32 - TASK_SLOT_INDEX_BITS;
export const TASK_SLOT_META_VALUE_MASK = 0xFFFFFFFF >>> TASK_SLOT_INDEX_BITS;
const TASK_SLOT_META_PACKED_MASK = (~TASK_SLOT_INDEX_MASK) >>> 0;

export const TASK_FUNCTION_ID_BITS = 16;
export const TASK_FUNCTION_ID_MASK = (1 << TASK_FUNCTION_ID_BITS) - 1;
export const TASK_FUNCTION_META_BITS = 32 - TASK_FUNCTION_ID_BITS;
export const TASK_FUNCTION_META_VALUE_MASK =
  0xFFFFFFFF >>> TASK_FUNCTION_ID_BITS;
const TASK_FUNCTION_META_PACKED_MASK = (~TASK_FUNCTION_ID_MASK) >>> 0;

export const getTaskFunctionID = (task: ArrayLike<number>): number =>
  task[TaskIndex.FunctionID] & TASK_FUNCTION_ID_MASK;

export const setTaskFunctionID = (task: Task, functionID: number): void => {
  task[TaskIndex.FunctionID] =
    (
      (task[TaskIndex.FunctionID] & TASK_FUNCTION_META_PACKED_MASK) |
      (functionID & TASK_FUNCTION_ID_MASK)
    ) >>> 0;
};

export const getTaskFunctionMeta = (task: ArrayLike<number>): number =>
  (task[TaskIndex.FunctionID] >>> TASK_FUNCTION_ID_BITS) &
  TASK_FUNCTION_META_VALUE_MASK;

export const setTaskFunctionMeta = (task: Task, value: number): void => {
  const encodedMeta =
    ((value & TASK_FUNCTION_META_VALUE_MASK) << TASK_FUNCTION_ID_BITS) >>> 0;
  task[TaskIndex.FunctionID] =
    ((task[TaskIndex.FunctionID] & TASK_FUNCTION_ID_MASK) | encodedMeta) >>> 0;
};

export const getTaskSlotIndex = (task: ArrayLike<number>): number =>
  task[TaskIndex.slotBuffer] & TASK_SLOT_INDEX_MASK;

export const setTaskSlotIndex = (task: Task, slotIndex: number): void => {
  task[TaskIndex.slotBuffer] =
    (
      (task[TaskIndex.slotBuffer] & TASK_SLOT_META_PACKED_MASK) |
      (slotIndex & TASK_SLOT_INDEX_MASK)
    ) >>> 0;
};

export const getTaskSlotMeta = (task: ArrayLike<number>): number =>
  (task[TaskIndex.slotBuffer] >>> TASK_SLOT_INDEX_BITS) &
  TASK_SLOT_META_VALUE_MASK;

export const setTaskSlotMeta = (task: Task, value: number): void => {
  const encodedMeta =
    ((value & TASK_SLOT_META_VALUE_MASK) << TASK_SLOT_INDEX_BITS) >>> 0;
  task[TaskIndex.slotBuffer] =
    ((task[TaskIndex.slotBuffer] & TASK_SLOT_INDEX_MASK) | encodedMeta) >>> 0;
};

export enum TaskFlag {
  Reject = 1 << 0,
}

// Main queue lock layout in bytes.
// Keep each lock word on its own cache line inside the first 256 bytes.
export const LOCK_WORD_BYTES = Int32Array.BYTES_PER_ELEMENT;
export const LOCK_HOST_BITS_OFFSET_BYTES = LockBound.paddingLock;
export const LOCK_WORKER_BITS_OFFSET_BYTES = LOCK_CACHE_LINE_BYTES;
export const LOCK_SECTOR_BYTE_LENGTH = LOCK_SECTOR_BYTES;

// Payload allocator lock layout in bytes.
// Share the same SAB as the main queue lock, but give each word its own line.
export const PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES = LOCK_CACHE_LINE_BYTES * 2;
export const PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES = LOCK_CACHE_LINE_BYTES * 3;
export const PAYLOAD_LOCK_SECTOR_BYTE_LENGTH = LOCK_SECTOR_BYTES;

// Header layout in Uint32 units.
// Each slot stores aligned static payload bytes first, with the task header
// packed into the final words of the slot.
export const HEADER_SLOT_STRIDE_U32 = LockBound.header + TaskIndex.TotalBuff;
export const HEADER_STATIC_PAYLOAD_U32 = TaskIndex.TotalBuff - TaskIndex.Size;
export const HEADER_TASK_OFFSET_IN_SLOT_U32 = HEADER_STATIC_PAYLOAD_U32;
export const HEADER_U32_LENGTH =
  LockBound.header + (HEADER_SLOT_STRIDE_U32 * LockBound.slots);
export const HEADER_BYTE_LENGTH = HEADER_U32_LENGTH * Uint32Array.BYTES_PER_ELEMENT;


let INDEX_ID = 0;
const INIT_VAL = PayloadSignal.UNREACHABLE;
const def = (_?: unknown) => {};

type TaskShell = Task & {
  [PromisePayloadMarker]?: boolean;
  [PromisePayloadHandlerSymbol]?: PromisePayloadHandler;
  [PromisePayloadStatusSymbol]?: PromisePayloadStatus;
  [PromisePayloadResultSymbol]?: PromisePayloadResult;
  [PromisePayloadFulfillSymbol]?: (value: unknown) => void;
  [PromisePayloadRejectSymbol]?: (reason: unknown) => void;
};

const createTaskShell = () => {
  const task = new Uint32Array(TaskIndex.Size) as unknown as TaskShell;
  task.value = null;
  task.resolve = def;
  task.reject = def;
  // Keep Promise marker shape stable across task lifecycle.
  task[PromisePayloadMarker] = false;
  task[PromisePayloadHandlerSymbol] = undefined;
  task[PromisePayloadStatusSymbol] = PromisePayloadStatus.Idle;
  task[PromisePayloadResultSymbol] = {
    status: "fulfilled",
    value: undefined,
    reason: undefined,
  };
  task[PromisePayloadFulfillSymbol] = (value: unknown) => {
    task[PromisePayloadMarker] = false;
    task[PromisePayloadStatusSymbol] = PromisePayloadStatus.Fulfilled;
    task.value = value;
    const result = task[PromisePayloadResultSymbol]!;
    result.status = "fulfilled";
    result.value = value;
    result.reason = undefined;
    task[PromisePayloadHandlerSymbol]!(task, result);
  };
  task[PromisePayloadRejectSymbol] = (reason: unknown) => {
    task[PromisePayloadMarker] = false;
    task[PromisePayloadStatusSymbol] = PromisePayloadStatus.Rejected;
    task.value = reason;
    const result = task[PromisePayloadResultSymbol]!;
    result.status = "rejected";
    result.value = undefined;
    result.reason = reason;
    task[PromisePayloadHandlerSymbol]!(task, result);
  };
  return task;
};

export const makeTask = () => {
  const task = createTaskShell();
  task[TaskIndex.ID] = INDEX_ID++;
  return task;
};

const fillTaskFrom = (task: Task, array: ArrayLike<number>, at: number) => {
  task[0] = array[at];
  task[1] = array[at + 1];
  task[2] = array[at + 2];
  task[3] = array[at + 3];
  task[4] = array[at + 4];
  task[5] = array[at + 5];
  task[6] = array[at + 6];
  //task[7] = array[at + 7];
};

const makeTaskFrom = (array: Uint32Array, at: number) => {
  const task = createTaskShell();
  fillTaskFrom(task, array, at);
  return task;
};

  // could be inlined 
const settleTask = (task: Task) => {

  if( task[TaskIndex["FlagsToHost"]] === 0){
    task.resolve(task.value)
  }else{
    task.reject(task.value)
    // restarting the flag
    task[TaskIndex["FlagsToHost"]] = 0
  }


}

/**
 *
 * Complexity: 7 / 10
 *
 * SAFETY:
 *  - Single producer/consumer; do not call encode/decode concurrently.
 *  - Shared buffers must be the same between host/worker.
 *  - encode/decode are not re-entrant; payload codec uses a shared scratch buffer.
 */

export type ResolveHostOptions = {
  queue: Task[];
  onResolved?: (task: Task) => void;
};

export type Lock2 = {
  enlist: (task: Task) => void;
  encode: (task: Task, state?: number) => boolean;
  encodeManyFrom: (list: RingQueue<Task>) => number;
  encodeAll: () => boolean;
  decode: () => boolean;
  hasSpace: () => boolean;
  resolved: RingQueue<Task>;
  hostBits: Int32Array;
  workerBits: Int32Array;
  recyclecList: RingQueue<Task>;
  resolveHost: (options: ResolveHostOptions) => () => number;
  setPromiseHandler: (handler?: PromisePayloadHandler) => void;
};

export const lock2 = ({
  headers,
  LockBoundSector,
  payload,
  payloadConfig,
  payloadSector,
  resultList,
  toSentList,
  recycleList
}: {
  headers?: SharedArrayBuffer;
  LockBoundSector?: SharedArrayBuffer;
  payload?: SharedArrayBuffer;
  payloadConfig?: PayloadBufferOptions;
  payloadSector?: SharedArrayBuffer;
  toSentList?: RingQueue<Task>;
  resultList?: RingQueue<Task>;
  recycleList?: RingQueue<Task>;
}) => {


  // Layout:
  // - hostBits starts at byte `paddingLock`
  // - workerBits starts immediately after hostBits
  // This intentionally allows false sharing on the main queue lock.
  //
  // Important: encode() always toggles `hostBits` and decode/resolveHost always
  // toggles `workerBits`, regardless of which thread calls them. This is why
  // the "return lock" (worker->host responses) still publishes into `hostBits`.
  const LockBoundSAB =
    LockBoundSector ??
    new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);

  const hostBits = new Int32Array(LockBoundSAB, LOCK_HOST_BITS_OFFSET_BYTES, 1);
  const workerBits = new Int32Array(
    LockBoundSAB,
    LOCK_WORKER_BITS_OFFSET_BYTES,
    1,
  );

  // Logical positions for each slot payload in headersBuffer.
  // (Layout unchanged from your version.)

  const bufferHeadersBuffer:SharedArrayBuffer =  headers ??
      new SharedArrayBuffer(HEADER_BYTE_LENGTH)

  const headersBuffer = new Uint32Array(
  bufferHeadersBuffer
  );

  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payload,
    options: payloadConfig,
  });
  const payloadSAB = payload ??
    (
      resolvedPayloadConfig.mode === "growable"
        ? createSharedArrayBuffer(
          resolvedPayloadConfig.payloadInitialBytes,
          resolvedPayloadConfig.payloadMaxByteLength,
        )
        : createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes)
    );
  const payloadLockSAB = payloadSector ?? LockBoundSAB;
  const payloadRegister = register({
    lockSector: payloadLockSAB,
  });

  let promiseHandler: PromisePayloadHandler | undefined;

  const encodeTask = encodePayload({
    payload: {
      sab: payloadSAB,
      config: resolvedPayloadConfig,
    },
    headersBuffer,
    lockSector: payloadLockSAB,
    onPromise: (task, result) => promiseHandler?.(task, result),
    sharedRegister: payloadRegister,
  });
  const decodeTask = decodePayload({
    payload: {
      sab: payloadSAB,
      config: resolvedPayloadConfig,
    },
    headersBuffer,
    lockSector: payloadLockSAB,
    sharedRegister: payloadRegister,
  });

  let LastLocal = 0 | 0;
  let LastWorker = 0 | 0;
  let lastTake = 32 | 0;

  const toBeSent = toSentList ?? new RingQueue();
  const recyclecList = recycleList ?? new RingQueue();

  const resolved = resultList ?? new RingQueue<Task>();

  // Atomics aliases (hot path)
  const a_load = Atomics.load;
  const a_store = Atomics.store;

  // RingQueue method aliases (hot path)
  const toBeSentPush = (task: Task) => toBeSent.push(task);
  const toBeSentShift = () => toBeSent.shiftNoClear();
  const toBeSentUnshift = (task: Task) => toBeSent.unshift(task);
  const recycleShift = () => recyclecList.shiftNoClear();
  const resolvedPush = (task: Task) => resolved.push(task);

  const SLOT_SIZE = HEADER_SLOT_STRIDE_U32;
  const clz32 = Math.clz32;
  const slotOffset = (at: number) =>
    (at * SLOT_SIZE) + LockBound.header + HEADER_TASK_OFFSET_IN_SLOT_U32;
  const takeTask = ({ queue }: { queue: Task[] }) =>
    (at: number) => {
      const off = slotOffset(at);
      const task = queue[headersBuffer[off + TaskIndex.ID]!];
      fillTaskFrom(task, headersBuffer, off);
      return task;
    };

  const enlist = (task: Task) => toBeSentPush(task);
  let selectedSlotIndex = 0 | 0, selectedSlotBit = 0 >>> 0;


  const encodeWithState = (task: Task, state: number): number => {
    const free = ~state;
    if (free === 0) return 0;

    if (!encodeTask(task, selectedSlotIndex = 31 - clz32(free))) return 0;
    encodeAt(
      task,
      selectedSlotIndex,
      selectedSlotBit = 1 << selectedSlotIndex,
    );
    return selectedSlotBit;
  };

  const encodeManyFrom = (list: RingQueue<Task>): number => {
    let state = (LastLocal ^ a_load(workerBits, 0)) | 0;
    let encoded = 0 | 0;

    if (list === toBeSent) {
      while (true) {
        const task = toBeSentShift();
        if (!task) break;

        const bit = encodeWithState(task, state) | 0;
        if (bit === 0) {
          toBeSentUnshift(task);
          break;
        }

        state = (state ^ bit) | 0;
        encoded = (encoded + 1) | 0;
      }
    } else {
      while (true) {
        const task = list.shiftNoClear();
        if (!task) break;

        const bit = encodeWithState(task, state) | 0;
        if (bit === 0) {
          list.unshift(task);
          break;
        }

        state = (state ^ bit) | 0;
        encoded = (encoded + 1) | 0;
      }
    }

    return encoded;
  };

  const encodeAll = (): boolean => {
    if (toBeSent.isEmpty) return true;
    encodeManyFrom(toBeSent);
    return toBeSent.isEmpty;
  };

  const storeHost = (bit: number) =>
    a_store(hostBits, 0, LastLocal = (LastLocal ^ bit) | 0);
  const storeWorker = (bit: number) =>
    a_store(workerBits, 0, LastWorker = (LastWorker ^ bit) | 0);
  const encode = (
    task: Task,
    state: number = (LastLocal ^ a_load(workerBits, 0)) | 0,
  ): boolean => {
    const free = ~state;
    if (free === 0) return false;

    if (!encodeTask(task, selectedSlotIndex = 31 - clz32(free))) return false;
    return encodeAt(
      task,
      selectedSlotIndex,
      selectedSlotBit = 1 << selectedSlotIndex,
    );
  };

  const encodeAt = (task: Task, at: number, bit: number): boolean => {
    const off = slotOffset(at);
    headersBuffer[off] = task[0];
    headersBuffer[off + 1] = task[1];
    headersBuffer[off + 2] = task[2];
    headersBuffer[off + 3] = task[3];
    headersBuffer[off + 4] = task[4];
    headersBuffer[off + 5] = task[5];
    headersBuffer[off + 6] = task[6];
    headersBuffer[off + 7] = task[7];

    storeHost(bit);
    return true;
  };

  const hasSpace = () => (hostBits[0] ^ LastWorker) !== 0;

  /**
   * WORKER SIDE: decode
   */
  const decode = (): boolean => {
    let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
    if (diff === 0) return false;

    let last = lastTake;
    let consumedBits = 0 | 0;

    try {
      if (last === 32) {
        decodeAt(selectedSlotIndex = 31 - clz32(diff));
        selectedSlotBit = 1 << (last = selectedSlotIndex);
        diff ^= selectedSlotBit;
        consumedBits = (consumedBits ^ selectedSlotBit) | 0;
      }

      while (diff !== 0) {
        let pick = diff & ((1 << last) - 1);
        if (pick === 0) pick = diff;

        decodeAt(selectedSlotIndex = 31 - clz32(pick));
        selectedSlotBit = 1 << (last = selectedSlotIndex);
        diff ^= selectedSlotBit;
        consumedBits = (consumedBits ^ selectedSlotBit) | 0;
      }
    } finally {
      if (consumedBits !== 0) storeWorker(consumedBits);
    }

    lastTake = last;
    return true;
  };


  /**
   * HOST SIDE: decode version
   */
  const resolveHost = ({
    queue,
    onResolved,
  }: ResolveHostOptions) => {

    const getTask = takeTask({ queue });
    const HAS_RESOLVE = onResolved ? true : false;
    let lastResolved = 32;


    return (): number => {
      let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
      if (diff === 0) return 0;

      let modified = 0;
      let consumedBits = 0 | 0;
      let last = lastResolved;

      if (last === 32) {
        const idx = 31 - clz32(diff);
        const selectedBit = 1 << idx;

        const task = getTask(idx);
        decodeTask(task, idx);

        consumedBits = (consumedBits ^ selectedBit) | 0;
        settleTask(task);
        if (HAS_RESOLVE) {
          onResolved!(task);
        }

        diff ^= selectedBit;
        modified++;

        if ((modified & 7) === 0 && consumedBits !== 0) {
          LastWorker = (LastWorker ^ consumedBits) | 0;
          a_store(workerBits, 0, LastWorker);
          consumedBits = 0 | 0;
        }
        last = idx;
      }

      while (diff !== 0) {
        const lowerMask = last === 31 ? 0x7fffffff : ((1 << last) - 1);
        let pick = diff & lowerMask;
        if (pick === 0) pick = diff;
        const idx = 31 - clz32(pick);
        const selectedBit = 1 << idx;

        const task = getTask(idx);
        decodeTask(task, idx);

        consumedBits = (consumedBits ^ selectedBit) | 0;
        settleTask(task);
        if (HAS_RESOLVE) {
          onResolved!(task);
        }

        diff ^= selectedBit;
        modified++;
        if ((modified & 7) === 0 && consumedBits !== 0) {
          LastWorker = (LastWorker ^ consumedBits) | 0;
          a_store(workerBits, 0, LastWorker);
          consumedBits = 0 | 0;
        }
        last = idx;
      }

      if (consumedBits !== 0) {
        LastWorker = (LastWorker ^ consumedBits) | 0;
        a_store(workerBits, 0, LastWorker);
      }

      lastResolved = last;
      return modified;
    };
  }


  const decodeAt = (at: number): boolean => {
    const off = slotOffset(at);
    const recycled = recycleShift() as Task | undefined;
    let task: Task;
    if (recycled) {
      fillTaskFrom(recycled, headersBuffer, off);
      recycled.value = null;
      recycled.resolve = def;
      recycled.reject = def;
      task = recycled;
    } else {
      task = makeTaskFrom(headersBuffer, off);
    }

    decodeTask(task, at);
    resolvedPush(task);

    return true;
  };

  

  return {
    enlist,
    encode,
    encodeManyFrom,
    encodeAll,
    decode,
    hasSpace,
    resolved,
    hostBits,
    workerBits,
    recyclecList,
    resolveHost,
    setPromiseHandler: (handler?: PromisePayloadHandler) => {
      promiseHandler = handler;
    },
  };
};
