import LinkList from "../ipc/tools/LinkList.ts";
import { decodePayload, encodePayload } from "./payloadCodec.ts";


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
}



export enum LockBound {
  padding = 64,
  slots = 32,
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
  TotalBuff = 32
}

export enum TaskFlag {
  Reject = 1 << 0,
}


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

   const task = new Uint32Array(TaskIndex.Size) as Uint32Array & {
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
 
    const slotOffset = (at * (
      LockBound.padding + TaskIndex.TotalBuff
    )) + LockBound.padding;
  
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
    new SharedArrayBuffer(LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2);

  const hostBits = new Uint32Array(LockBoundSAB, LockBound.padding, 1);
  const workerBits = new Uint32Array(
    LockBoundSAB,
    LockBound.padding * 2,
    1,
  );

  // Logical positions for each slot payload in headersBuffer.
  // (Layout unchanged from your version.)

  const bufferHeadersBuffer:SharedArrayBuffer =  headers ??
      new SharedArrayBuffer(
        (LockBound.padding + ((LockBound.slots * TaskIndex.TotalBuff)) * LockBound.slots),
      )

  const headersBuffer = new Uint32Array(
  bufferHeadersBuffer
  );

  const payloadSAB = payload ??
    new SharedArrayBuffer(
      4 * 1024 * 1024,
      { maxByteLength: 64 * 1024 * 1024 },
    );
  const payloadLockSAB = payloadSector ??
    new SharedArrayBuffer(LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2);

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

  let LastLocal = 0 >>> 0
let LastWorker = 0 >>> 0;

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


const SLOT_SIZE = LockBound.padding + TaskIndex.TotalBuff;


const clz32 = Math.clz32
const slotOffset = (at: number) =>
  (at * SLOT_SIZE) +  LockBound.padding ;

  const enlist = (task: Task) => toBeSentPush(task)


  const encodeWithState = (task: Task, state: number): number => {
    const free = (~state) >>> 0;
    if (free === 0) return 0;

    uwuIdx = 31 - clz32(free);
    if (!encodeTask(task, uwuIdx)) return 0;

    uwuBit = 1 << uwuIdx;
    encodeAt(task, uwuIdx, uwuBit);
    return uwuBit;
  };

  const encodeManyFrom = (list: LinkList<Task>): number => {
    const workerSnapshot = a_load(workerBits, 0);
    let state = LastLocal ^ workerSnapshot;
    let encoded = 0;

    if (list === toBeSent) {
      while (true) {
        const task = toBeSentShift();
        if (!task) break;

        const bit = encodeWithState(task, state);
        if (bit === 0) {
          toBeSentUnshift(task);
          break;
        }

        state ^= bit;
        encoded++;
      }
    } else {
      while (true) {
        const task = list.shift();
        if (!task) break;

        const bit = encodeWithState(task, state);
        if (bit === 0) {
          list.unshift(task);
          break;
        }

        state ^= bit;
        encoded++;
      }
    }

    return encoded;
  };

  const encodeAll = (): boolean => {
    if (toBeSent.isEmpty) return true;
    encodeManyFrom(toBeSent);
    return toBeSent.isEmpty;
  };

  let uwuIdx = 0 | 0, uwuBit = 0 | 0

  const storeHost = (bit: number) => a_store(hostBits, 0, LastLocal ^= bit)
    const storeWorker = (bit: number) => a_store(workerBits, 0, LastWorker ^=  bit)
  const encode = (
    task: Task,
    state: number = (LastLocal ^ a_load(workerBits , 0)) ,
  ): boolean => {
    const free = (~state) >>> 0;
    if (free === 0) return false;

    const idx = 31 - clz32(free);
    uwuIdx = idx;
    if (!encodeTask(task, idx)) return false;

    const bit = 1 << idx;
    uwuBit = bit;
    return encodeAt(task, idx, bit);

  
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
    let modified = false;

    // bits that changed since last time on worker side
    let diff = a_load(hostBits, 0) ^ LastWorker;
    //diff &= SLOT_MASK;

    // Process all set bits in `diff`, one by one using clz32
    while (diff !== 0) {
      uwuIdx = 31 - clz32(diff);
    
      decodeAt(uwuIdx, uwuBit = 1 << uwuIdx);

      // clear that bit from diff
      diff &= ~uwuBit >>> 0;

      modified = true;
    }

    return modified;
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


    return (): number => {
    let diff = (a_load(hostBits, 0) ^ LastWorker) >>> 0;
    if (diff === 0) return 0;

    let modified = 0;
    let consumedBits = 0 >>> 0;

    while (diff !== 0) {
      const idx = 31 - clz32(diff);
      const  uwubit = (1 << idx) >>> 0;

      const task = getTask(headersBuffer, idx);
      decodeTask(task, idx);

      consumedBits ^= uwubit;
      settleTask(task);
      if(HAS_RESOLVE){
        onResolved!(task)
      }


      diff = (diff & ~uwubit) >>> 0;
      modified++;
    }

    if (consumedBits !== 0) {
      LastWorker = (LastWorker ^ consumedBits) >>> 0;
      a_store(workerBits, 0, LastWorker);
    }

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
