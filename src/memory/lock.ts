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
  for (let i = 0; i < TaskIndex.Size; i++) {
    task[i] = array[at + i];
  }
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
  // One mask per slot bit (0..31)
   const masks = new Uint32Array(32);
 
  for (let i = 0; i < 32; i++) {
    masks[i] = (1 << i) ;
 
  }

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

  const encodeTask = encodePayload({
    sab: payloadSAB,
    headersBuffer,
    lockSector: payloadLockSAB,
  });
  const decodeTask = decodePayload({
    sab: payloadSAB,
    headersBuffer,
    lockSector: payloadLockSAB,
  });

  const LastLocal = new Uint32Array(1)
  const LastWorker = new Uint32Array(1)

  const toBeSent = toSentList ?? new LinkList();
  const recyclecList = recycleList ?? new LinkList()



  const resolved = resultList ?? new LinkList<Task>();



const SLOT_SIZE = LockBound.padding + TaskIndex.TotalBuff;


const clz32 = Math.clz32
const slotOffset = (at: number) =>
  (at * SLOT_SIZE) +  LockBound.padding ;

  const enlist = (task: Task) => toBeSent.push(task)


  const encodeAll = (): boolean => {
   
    let node = (toBeSent as any).shift?.() as Task | undefined;

    const lastWorkerBits =  Atomics.load(workerBits, 0)
 
    if (!node) return true;


    while (node) {
      const task = node;

      if (!encode(task, LastLocal[0] ^  lastWorkerBits)) {
        // could not encode this one → put it back at the front
        // (if your LinkList has a different "push-front" name, swap here)
        toBeSent.unshift?.(task);

        return false;
      }

      node = toBeSent.shift?.() as Task | undefined;
    }

    // we drained the queue successfully
    return true;
  };

  let uwuIdx = 0 | 0, uwuBit = 0 | 0

  const a_s = Atomics.store
  const storeHost = (bit: number) => a_s(hostBits, 0, LastLocal[0] ^= bit)
    const storeWorker = (bit: number) => a_s(workerBits, 0, LastWorker[0] ^=  bit)
  const encode = (
    task: Task,
    state: number = (LastLocal[0] ^ Atomics.load(workerBits , 0)) ,
  ): boolean => {
   // free bits are ~state (only consider lower SLOT bits)
    let free = (~state >>> 0) //  & SLOT_MASK;
    if (free === 0) return false;

    // Take the highest free bit: idx = 31 - clz32(free)
    uwuIdx = 31 - clz32(free);
    if (!encodeTask(task, uwuIdx)) return false;
    
    return encodeAt(task, uwuIdx, 1 << uwuIdx);

  
  };

  const encodeAt = (task: Task, at: number, bit: number): boolean => {
    // write headers for this slot
    headersBuffer.set(task, slotOffset(at));

    // publish: toggle host side bit (0->1 or 1->0)
  

     storeHost(bit)

    return true;
  };

  const hasSpace = () => (hostBits[0] ^ LastWorker[0]) !== 0
  
  /**
   * WORKER SIDE: decode
   */
  const decode = (): boolean => {
    let modified = false;

    // bits that changed since last time on worker side
    let diff = Atomics.load(hostBits, 0) ^ LastWorker[0];
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


    return (): number => {
    let modified = 0;
    // TODO: check if shadowing here is needed
    let uwuIdx = 0 | 0, uwuBit = 0 | 0
    // bits that changed since last time on worker side
    let diff = Atomics.load(hostBits, 0) ^ LastWorker[0];
    //diff &= SLOT_MASK;

    // Process all set bits in `diff`, one by one using clz32
    while (diff !== 0) {
      uwuIdx = 31 - clz32(diff);
    
      const task = getTask(headersBuffer, uwuIdx)
      decodeTask(task,uwuIdx)
      // once we got it, we free it 
      storeWorker(
        // create the mask 
        uwuBit = 1 << uwuIdx
      )

      settleTask(task)
      onResolved?.(task)
      // clear that bit from diff
      diff &= ~uwuBit >>> 0;

      modified++;
    }

    return modified;
  };
  }


  const decodeAt = (at: number, bit: number): boolean => {
    const recycled = recyclecList.shift?.() as Task | undefined;
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


    resolved.push(task);

    return true;
  };

  

  return {
    enlist,
    encode,
    encodeAll,
    decode,
    hasSpace,
    resolved,
    hostBits,
    workerBits,
    recyclecList,
    resolveHost
  };
};
