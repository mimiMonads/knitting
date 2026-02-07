import LinkList from "../ipc/tools/LinkList.ts";
import { decodePayload, encodePayload } from "./payloadCodec.ts";
import { HAS_SAB_GROW, createSharedArrayBuffer } from "../common/runtime.ts";


/**
 * TODO: Compose all the instance where the array is passed as argument
 * 
 * 
 */

 export enum PayloadSingal {
  UNREACHABLE = 0,
  BigInt = 2,
  True = 3,
  False = 4,
  Undefined = 5,
  NaN = 6,
  Infinity = 7,
  NegativeInfinity = 8,
  Float64 = 9,
  Null = 10,
}

export enum PayloadBuffer {
  BORDER_SIGNAL_BUFFER = 11,
  String = 11,
  Json = 12,
  Serializable = 13,
  NumericBuffer = 14,
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
  StaticSerializable = 30,
  StaticInt32Array = 31,
  StaticFloat64Array = 32,
  StaticBigInt64Array = 33,
  StaticBigUint64Array = 34,
  StaticDataView = 35,
}



export enum LockBound {
  padding = 64,
  slots = 32,
  header = 0,
}

export type Task = [
  number,
  number,
  PayloadSingal | PayloadBuffer,
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

export type PromisePayloadResult =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: unknown };

export type PromisePayloadHandler = (
  task: Task,
  result: PromisePayloadResult,
) => void;

export enum TaskIndex {
  /**
   * Flags for host
   */
  FlagsToHost = 0,
  /**
   * IMPORTANT: FuntionID is only use for worker to host
   * reserved for special flags from host to worker
   */
  FuntionID = 0,
  ID = 1,
  Type = 2,
  Start = 3,
  End = 4,
  PayloadLen = 5,
  slotBuffer = 6,
  Size = 8,
  TotalBuff = 128
}

export enum TaskFlag {
  Reject = 1 << 0,
}

// Lock-sector layout in bytes.
// Keep host/worker words one cache-line apart to avoid false sharing.
export const LOCK_WORD_BYTES = Int32Array.BYTES_PER_ELEMENT;
export const LOCK_HOST_BITS_OFFSET_BYTES = LockBound.padding;
export const LOCK_WORKER_BITS_OFFSET_BYTES = LockBound.padding * 2;
export const LOCK_SECTOR_BYTE_LENGTH =
  LOCK_WORKER_BITS_OFFSET_BYTES + LOCK_WORD_BYTES;

// Header layout in Uint32 units.
export const HEADER_SLOT_STRIDE_U32 = LockBound.header + TaskIndex.TotalBuff;
export const HEADER_U32_LENGTH =
  LockBound.header + (HEADER_SLOT_STRIDE_U32 * LockBound.slots);
export const HEADER_BYTE_LENGTH = HEADER_U32_LENGTH * Uint32Array.BYTES_PER_ELEMENT;


let INDEX_ID = 0;
const INIT_VAL = PayloadSingal.UNREACHABLE;
const def = (_?: unknown) => {};

export const makeTask = () => {
  
 const task = new Uint32Array(TaskIndex.Size) as Uint32Array & {
    value: unknown
    resolve: (value?: unknown)=>void
    reject:  (reason?: unknown)=>void
  } as unknown as Task


  task[TaskIndex.ID] = INDEX_ID++
  task.value = null;
  task.resolve = def;
  task.reject = def;
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

const makeTaskFrom = (array: ArrayLike<number>, at: number) => {

   const task = new Uint32Array(TaskIndex.Size) as unknown as Uint32Array & {
    value: unknown
    resolve: (value?: unknown)=>void
    reject:  (reason?: unknown)=>void
  } as unknown as Task


  fillTaskFrom(task, array, at);

  task.value = null;
  task.resolve = def;
  task.reject = def;
  return task;
};



// To be inline in the future
const takeTask = ({ queue }: {
  queue: Task[];
}) =>
  (array: ArrayLike<number>, at: number) => {
 
    const slotOffset = (at * HEADER_SLOT_STRIDE_U32) + LockBound.header;
  
    const task = queue[array[slotOffset + TaskIndex["ID"]]]
    fillTaskFrom(task, array, slotOffset);

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

export type Lock2 = ReturnType<typeof lock2>

export const lock2 = ({
  headers,
  LockBoundSector,
  payload,
  payloadSector,
  resultList,
  toSentList,
  recycleList
}: {
  headers?: SharedArrayBuffer;
  LockBoundSector?: SharedArrayBuffer;
  payload?: SharedArrayBuffer;
  payloadSector?: SharedArrayBuffer;
  toSentList?: LinkList<Task>;
  resultList?: LinkList<Task>;
  recycleList?: LinkList<Task>;
}) => {


    // Layout:
  // [ padding (64 bytes) ]
  // [ hostBits:Int32 (4 bytes) ]
  // [ padding (64 bytes) ]
  // [ workerBits:Int32 (4 bytes) ]
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

  const payloadMaxBytes = 64 * 1024 * 1024;
  const payloadInitialBytes = HAS_SAB_GROW ? 4 * 1024 * 1024 : payloadMaxBytes;
  const payloadSAB = payload ??
    createSharedArrayBuffer(
      payloadInitialBytes,
      payloadMaxBytes,
    );
  const payloadLockSAB = payloadSector ??
    new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);

  let promiseHandler: PromisePayloadHandler | undefined;

  const encodeTask = encodePayload({
    sab: payloadSAB,
    headersBuffer,
    lockSector: payloadLockSAB,
    onPromise: (task, result) => promiseHandler?.(task, result),
  });
  const decodeTask = decodePayload({
    sab: payloadSAB,
    headersBuffer,
    lockSector: payloadLockSAB,
  });

  let LastLocal = 0 | 0;
  let LastWorker = 0 | 0;
  let lastTake = 32 | 0;

  const toBeSent = toSentList ?? new LinkList();
  const recyclecList = recycleList ?? new LinkList()



  const resolved = resultList ?? new LinkList<Task>();

  // Atomics aliases (hot path)
  const a_load = Atomics.load;
  const a_store = Atomics.store;

  // LinkedList method aliases (hot path)
  const toBeSentPush = (task: Task) => toBeSent.push(task);
  const toBeSentShift = () => toBeSent.shift();
  const toBeSentUnshift = (task: Task) => toBeSent.unshift(task);
  const recycleShift = () => recyclecList.shift();
  const resolvedPush = (task: Task) => resolved.push(task);


const SLOT_SIZE = HEADER_SLOT_STRIDE_U32;


const clz32 = Math.clz32
const slotOffset = (at: number) =>
  (at * SLOT_SIZE) +  LockBound.header ;

  const enlist = (task: Task) => toBeSentPush(task)


  const encodeWithState = (task: Task, state: number): number => {
    const free = ~state;
    if (free === 0) return 0;

  
    if (!encodeTask(task, uwuIdx = 31 - clz32(free))) return 0;

    
    encodeAt(task, uwuIdx, uwuBit = 1 << uwuIdx);
    return uwuBit;
  };

  const encodeManyFrom = (list: LinkList<Task>): number => {
   
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
        const task = list.shift();
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

  let uwuIdx = 0 | 0, uwuBit = 0 >>> 0

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


    if (!encodeTask(task, uwuIdx = 31 - clz32(free))) return false;

   
    return encodeAt(task, uwuIdx, uwuBit = 1 << uwuIdx);

  
  };

  const encodeAt = (task: Task, at: number, bit: number): boolean => {
    // write headers for this slot
    const off = slotOffset(at);

  headersBuffer[off]     = task[0];
  headersBuffer[off + 1] = task[1];
  headersBuffer[off + 2] = task[2];
  headersBuffer[off + 3] = task[3];
  headersBuffer[off + 4] = task[4];
  headersBuffer[off + 5] = task[5];
  headersBuffer[off + 6] = task[6];
  //headersBuffer[off + 7] = task[7];
  

     storeHost(bit)

    return true;
  };

  const hasSpace = () => (hostBits[0] ^ LastWorker) !== 0
  
  /**
   * WORKER SIDE: decode
   */
  const decode = (): boolean => {
    // bits that changed since last time on worker side
    let diff = (a_load(hostBits, 0) ^ LastWorker) 
   
    if (diff === 0) return false;

    let last = lastTake;

    if (last === 32) {
      
      decodeAt(uwuIdx = 31 - clz32(diff), uwuBit = 1 << (last = uwuIdx));
      diff ^= uwuBit;
    }

    while (diff !== 0) {
      let pick = diff & ((1 << last) - 1) ;
      if (pick === 0) pick = diff;
     
      decodeAt(uwuIdx = 31 - clz32(pick), uwuBit = 1 << (last = uwuIdx));
      diff ^= uwuBit;
  
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
  }: {
    queue: Task[],
    onResolved?: (task: Task) => void,
  }) => {

    const getTask = takeTask({
      queue
    })

    const HAS_RESOLVE = onResolved ? true : false
    let lastResolved = 32;


    return (): number => {
    let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
    if (diff === 0) return 0;

    let modified = 0;
    let consumedBits = 0 | 0;
    let last = lastResolved;

    if (last === 32) {
      const idx = 31 - clz32(diff);
      const uwubit = 1 << idx;

      const task = getTask(headersBuffer, idx);
      decodeTask(task, idx);

      consumedBits = (consumedBits ^ uwubit) | 0;
      settleTask(task);
      if(HAS_RESOLVE){
        onResolved!(task)
      }

      diff ^= uwubit;
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
      const uwubit = 1 << idx;

      const task = getTask(headersBuffer, idx);
      decodeTask(task, idx);

      consumedBits = (consumedBits ^ uwubit) | 0;
      settleTask(task);
      if(HAS_RESOLVE){
        onResolved!(task)
      }

      diff ^= uwubit;
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
    //if (a_load(hostBits, 0) === LastWorker) lastResolved = 32;
    return modified;
  };
  }


  const decodeAt = (at: number, bit: number): boolean => {
    const recycled = recycleShift() as Task | undefined;
    let task: Task;
    if (recycled) {
      fillTaskFrom(recycled, headersBuffer, slotOffset(at));
      recycled.value = null;
      recycled.resolve = def;
      recycled.reject = def;
      task = recycled;
    } else {
      task = makeTaskFrom(headersBuffer, slotOffset(at));
    }

    // workerBits[0] = LastWorker[0] ^=  bit
   
    decodeTask(task, at)
    storeWorker(bit)


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
