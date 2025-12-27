import LinkList from "../ipc/tools/LinkList.ts";
import { decodePayload, encodePayload } from "./payloadCodec.ts";

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
  String = 11
}



export enum Lock {
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
] & {
  value: unknown;
  resolve: { (): void };
  reject: { (): void };
};

export enum TaskIndex {
  FuntionID = 0,
  ID = 1,
  Type = 2,
  Start = 3,
  End = 4,
  PayloadLen = 5,
  Size = 8,
}


let INDEX_ID = 0;
const INIT_VAL = PayloadSingal.UNREACHABLE;
const def = () => {};

export const makeTask = () => {
  
 const task = new Uint32Array(TaskIndex.Size) as Uint32Array & {
    value: unknown
    resolve: ()=>void
    reject:  ()=>void
  } as unknown as Task


  task[TaskIndex.ID] = INDEX_ID++
  task.value = null;
  task.resolve = def;
  task.reject = def;
  return task;
};


const makeTaskFrom = (array: ArrayLike<number>, at: number) => {

   const task = new Uint32Array(TaskIndex.Size) as Uint32Array & {
    value: unknown
    resolve: (key:void)=>void
    reject:  (key:void)=>void
  } as unknown as Task


  task[0] = array[at]
  task[1] = array[at] +1 
  task[2] = array[at] +2 
  task[3] = array[at] +3 
  task[4] = array[at] +4

  task.value = null;
  task.resolve = def;
  task.reject = def;
  return task;
};

export const lock2 = ({
  headers,
  lockSector,
  resultList,
  toSentList,
  recycleList
}: {
  headers?: SharedArrayBuffer;
  lockSector?: SharedArrayBuffer;
  toSentList?: LinkList<Task>;
  resultList?: LinkList<Task>;
  recycleList?: LinkList<Task>;
}) => {
  // One mask per slot bit (0..31)
   const masks = new Uint32Array(32);
 
  for (let i = 0; i < 32; i++) {
    masks[i] = (1 << i) ;
 
  }



  const LastLocal = new Uint32Array(1)
  const LastWorker = new Uint32Array(1)

  const toBeSent = toSentList ?? new LinkList();
  const recyclecList = recycleList ?? new LinkList()
  // Layout:
  // [ padding (64 bytes) ]
  // [ hostBits:Int32 (4 bytes) ]
  // [ padding (64 bytes) ]
  // [ workerBits:Int32 (4 bytes) ]
  const lockSAB =
    lockSector ??
    new SharedArrayBuffer(Lock.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2);

  const hostBits = new Uint32Array(lockSAB, Lock.padding, 1);
  const workerBits = new Uint32Array(
    lockSAB,
    Lock.padding * 2,
    1,
  );


  const resolved = resultList ?? new LinkList<Task>();

  // Logical positions for each slot payload in headersBuffer.
  // (Layout unchanged from your version.)
  const headersBuffer = new Int32Array(
    headers ??
      new SharedArrayBuffer(
        (Lock.padding + (Lock.slots * TaskIndex.Size)) * Lock.slots,
      ),
  );

const SLOT_SIZE = Lock.padding + TaskIndex.Size;


const clz32 = Math.clz32
const slotOffset = (at: number) =>
  Lock.padding + (at * SLOT_SIZE);

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

  let uwuIdx = 0, uwuBit = 0

  const a_s = Atomics.store
  const storeHost = (bit: number) => a_s(hostBits, 0, LastLocal[0] ^= bit)
    const storeWorker = (bit: number) => a_s(workerBits, 0, LastWorker[0] ^=  bit)
  const encode = (
    task: Task,
    state: number = (LastLocal[0] ^ Atomics.load(workerBits , 0)) ,
  ): boolean => {
    encodePayload(task);

    // free bits are ~state (only consider lower SLOT bits)
    let free = (~state >>> 0) //  & SLOT_MASK;
    if (free === 0) return false;

    // Take the highest free bit: idx = 31 - clz32(free)
    uwuIdx = 31 - clz32(free);
    
    return encodeAt(task, uwuIdx, 1 << uwuIdx);
  };

  const encodeAt = (task: Task, at: number, bit: number): boolean => {
    // write headers for this slot
    headersBuffer.set(task, slotOffset(at));

    // publish: toggle host side bit (0->1 or 1->0)
  

     storeHost(bit)

    return true;
  };

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


  const decodeAt = (at: number, bit: number): boolean => {
    const task = makeTaskFrom(headersBuffer, slotOffset(at));


    //workerBits[0] = LastWorker[0] ^=  bit
    storeWorker(bit)

    decodePayload(task)

    resolved.push(task);

    return true;
  };

  return {
    enlist,
    encode,
    encodeAll,
    decode,
    resolved,
    hostBits,
    workerBits,
    recyclecList
  };
};
