import LinkList from "../ipc/tools/LinkList.ts";

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
  number
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
  Length = 5,
}


let INDEX_ID = 0;
const INIT_VAL = PayloadSingal.UNREACHABLE;
const def = () => {};

export const makeTask = () => {
  
  const task = [
    INIT_VAL,
    INDEX_ID++,
    INIT_VAL,
    INIT_VAL,
    INIT_VAL,
  ] as unknown as Task;
  task.value = null;
  task.resolve = def;
  task.reject = def;
  return task;
};


const makeTaskFrom = (array: ArrayLike<number>, at: number) => {
  const task = [
    array[at],
    array[at] + 1,
    array[at] + 2,
    array[at] + 3,
    array[at] + 4,
  ] as unknown as Task;
  task.value = null;
  task.resolve = def;
  task.reject = def;
  return task;
};

export const lock2 = ({
  headers,
  lockSector,
  resultList,
  toSentList
}: {
  headers?: SharedArrayBuffer;
  lockSector?: SharedArrayBuffer;
  toSentList?: LinkList<Task>;
  resultList?: LinkList<Task>;
}) => {
  // One mask per slot bit (0..31)
   const masks = new Uint32Array(32);
   const maskNOT = new Uint32Array(32);
   const endBuffer = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    masks[i] = (1 << i) >>> 0;
    maskNOT[i] = ~maskNOT;
  }


  const toBeSent = toSentList ?? new LinkList();
  // Layout:
  // [ padding (64 bytes) ]
  // [ hostBits:Int32 (4 bytes) ]
  // [ padding (64 bytes) ]
  // [ workerBits:Int32 (4 bytes) ]
  const lockSAB =
    lockSector ??
    new SharedArrayBuffer(Lock.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2);

  const hostBits = new Int32Array(lockSAB, Lock.padding, 1);
  const workerBits = new Int32Array(
    lockSAB,
    Lock.padding * 2,
    1,
  );

  // Start with both sides in sync (no pending messages)
  // Atomics.store(hostBits, 0, 0);
  // Atomics.store(workerBits, 0, 0);

  const resolved = resultList ?? new LinkList<Task>();

  // Logical positions for each slot payload in headersBuffer.
  // (Layout unchanged from your version.)
  const headersBuffer = new Int32Array(
    headers ??
      new SharedArrayBuffer(
        (Lock.padding + (Lock.slots * TaskIndex.Length)) * Lock.slots,
      ),
  );

const SLOT_SIZE = Lock.padding + TaskIndex.Length;

const slotOffset = (at: number) =>
  Lock.padding + (at * SLOT_SIZE);

  /**
   * HOST SIDE: encode
   *
   */

  const enlist = (task: Task) => toBeSent.push(task)

    // NEW: try to encode all tasks currently in toBeSent
  //
  // - Returns true if *all* pending tasks were encoded (queue fully drained).
  // - Returns false if we ran out of slots; in that case:
  //   - Already-sent tasks are in the slots,
  //   - Remaining tasks (including the one that failed) stay in toBeSent.
  const encodeAll = (): boolean => {
    // assuming LinkList has shift() (FIFO). Adjust if your API differs.
    let node = (toBeSent as any).shift?.() as Task | undefined;

    const state = hostBits[0] ^ Atomics.load(workerBits, 0)
    // nothing to send → trivially succeeded
    if (!node) return true;

    while (node) {
      const task = node;

      if (!encode(task, state)) {
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

  const encode = (task: Task, state = hostBits[0] ^ Atomics.load(workerBits, 0) ): boolean => {
    encodePayload(task);

    // eventually consistent, for single host / single worker
    for (let at = 0; at < Lock.slots; at++) {
      const bit = masks[at];

      // no pending message in this slot if sequence bits are equal
      
      if (( state & bit) === 0) {
        return encodeAt(task, at, bit);
      }
    }

    return false;
  };

  const encodeAt = (task: Task, at: number, bit: number): boolean => {
    // write headers for this slot
    headersBuffer.set(task, slotOffset(at));

    // publish: toggle host side bit (0->1 or 1->0)
    Atomics.xor(hostBits, 0, bit);

    return true;
  };

  /**
   * WORKER SIDE: decode
   *
   */
  const decode = (): boolean => {
    let modified = false;

    const diff = Atomics.load(hostBits, 0) ^ Atomics.load(workerBits, 0);

    // eventually consistent, single worker
    for (let at = 0; at < Lock.slots; at++) {
      const bit = masks[at];

      if ((diff & bit) !== 0) {
        if (decodeAt(at, bit)) {
          modified = true;
        }
      }
    }

    return modified;
  };

  const decodeAt = (at: number, bit: number): boolean => {
    const task = decodePayload(makeTaskFrom(headersBuffer, slotOffset(at)));

    resolved.push(task);


    Atomics.xor(workerBits, 0, bit);

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
  };
};
