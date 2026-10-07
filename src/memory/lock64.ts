import type RingQueue from "../ipc/tools/ring-queue.ts";
import type { Task } from "./lock.ts";

/**
 * The wide queue owns the same two cache lines as the 32-slot queue. Acquire
 * both halves with one 64-bit load, then alias the snapshot as Int32 words:
 * no BigInt shifts, masks, conversions or allocation on the bit-selection path.
 * Publications only touch the selected 32-bit half. The sender's shadow can
 * hide retired lanes, never invent free ones, and is refreshed only when BOTH
 * cached halves are full.
 */
export const createLock64 = ({
  hostBits,
  workerBits,
  headers,
  stride,
  taskOffset,
  encodeTask,
  decodeAt,
  onPublish,
  stageTicket,
  atomicTicketPublication,
}: {
  hostBits: Int32Array;
  workerBits: Int32Array;
  headers: Uint32Array;
  stride: number;
  taskOffset: number;
  encodeTask: (task: Task, slot: number) => boolean;
  decodeAt: (slot: number) => unknown;
  onPublish?: () => void;
  stageTicket?: (slot: number) => void;
  atomicTicketPublication: boolean;
}) => {
  const host64 = new BigInt64Array(hostBits.buffer, hostBits.byteOffset, 1);
  const worker64 = new BigInt64Array(
    workerBits.buffer,
    workerBits.byteOffset,
    1,
  );
  const snapshot64 = new BigInt64Array(1);
  const snapshot = new Int32Array(snapshot64.buffer);
  const ack64 = new BigInt64Array(1);
  const ack = new Int32Array(ack64.buffer);
  const pending = new Int32Array(2);
  const retire64 = new BigInt64Array(1);
  const retire = new Int32Array(retire64.buffer);
  const load = Atomics.load;
  const store = Atomics.store;
  const clz32 = Math.clz32;
  let local0 = 0 | 0, local1 = 0 | 0;
  let shadow0 = 0 | 0, shadow1 = 0 | 0;

  const refreshShadow = () => {
    snapshot64[0] = load(worker64, 0);
    shadow0 = snapshot[0]!;
    shadow1 = snapshot[1]!;
  };
  refreshShadow();

  const encode = (task: Task, state0 = (local0 ^ shadow0) | 0): boolean => {
    let state1 = (local1 ^ shadow1) | 0;
    if (state0 === -1 && state1 === -1) {
      refreshShadow();
      state0 = (local0 ^ shadow0) | 0;
      state1 = (local1 ^ shadow1) | 0;
      if (state0 === -1 && state1 === -1) return false;
    }
    const word = state1 !== -1 ? 1 : 0;
    const bitIndex = 31 - clz32(~(word === 1 ? state1 : state0));
    const at = (word << 5) + bitIndex;
    if (!encodeTask(task, at)) return false;

    const off = at * stride + taskOffset;
    headers[off] = task[0];
    headers[off + 1] = task[1];
    headers[off + 2] = task[2];
    headers[off + 3] = task[3];
    headers[off + 4] = task[4];
    headers[off + 5] = task[5];
    headers[off + 6] = task[6];
    headers[off + 7] = 0;

    const bit = 1 << bitIndex;
    const value = word === 1
      ? local1 = (local1 ^ bit) | 0
      : local0 = (local0 ^ bit) | 0;
    if (stageTicket !== undefined) {
      stageTicket(at);
      // Ticket consumers acquire the tail, which publishes this plain store.
      if (atomicTicketPublication) store(hostBits, word, value);
      else hostBits[word] = value;
    } else {
      store(hostBits, word, value);
      onPublish?.();
    }
    return true;
  };

  const encodeMany = (
    list: RingQueue<Task>,
    onDeferred?: (task: Task) => boolean,
  ): number => {
    let count = 0;
    while (true) {
      const task = list.shiftNoClear();
      if (task === undefined) break;
      if (!encode(task)) {
        if (onDeferred?.(task)) continue;
        list.unshift(task);
        break;
      }
      count++;
    }
    return count;
  };

  const loadPending = (): Int32Array => {
    snapshot64[0] = load(host64, 0);
    const host0 = snapshot[0]!, host1 = snapshot[1]!;
    snapshot64[0] = load(worker64, 0);
    pending[0] = host0 ^ snapshot[0]!;
    pending[1] = host1 ^ snapshot[1]!;
    return pending;
  };

  const retireSteal = (done0: number, done1: number): void => {
    if ((done0 | done1) === 0) return;
    ack[0] ^= done0;
    ack[1] ^= done1;
    retire[0] = done0;
    retire[1] = done1;
    Atomics.xor(worker64, 0, retire64[0]!);
  };

  /** Snapshot once, scan with clz32, and retire only successfully decoded lanes. */
  const makeDrain = (
    consume: (slot: number) => unknown,
    batchAck: boolean,
  ) => {
    let last = 64;
    return (): number => {
      snapshot64[0] = load(host64, 0);
      let diff0 = (snapshot[0]! ^ ack[0]!) | 0;
      let diff1 = (snapshot[1]! ^ ack[1]!) | 0;
      if ((diff0 | diff1) === 0) return 0;
      let done0 = 0 | 0, done1 = 0 | 0;
      let count = 0;
      // Visit the suffix below the cursor, the other half, then the remaining
      // prefix after wrap. Choose the half once per phase instead of per lane.
      let word = last >= 32 ? 1 : 0;
      let mask = last === 64
        ? -1
        : (last & 31) === 0
        ? 0
        : -1 >>> (32 - (last & 31));
      try {
        for (let phase = 0; phase < 3 && (diff0 | diff1) !== 0; phase++) {
          let bits = (word === 1 ? diff1 : diff0) & mask;
          const base = word << 5;
          while (bits !== 0) {
            const bitIndex = 31 - clz32(bits);
            const at = base + bitIndex;
            consume(at);
            const bit = 1 << bitIndex;
            bits ^= bit;
            if (word === 1) {
              diff1 ^= bit;
              done1 ^= bit;
            } else {
              diff0 ^= bit;
              done0 ^= bit;
            }
            last = at;
            count++;
            if (batchAck && (count & 7) === 0) {
              ack[0] ^= done0;
              ack[1] ^= done1;
              if (done0 === 0) store(workerBits, 1, ack[1]!);
              else if (done1 === 0) store(workerBits, 0, ack[0]!);
              else store(worker64, 0, ack64[0]!);
              done0 = done1 = 0;
            }
          }
          word ^= 1;
          mask = -1;
        }
      } finally {
        if ((done0 | done1) !== 0) {
          ack[0] ^= done0;
          ack[1] ^= done1;
          if (done0 === 0) store(workerBits, 1, ack[1]!);
          else if (done1 === 0) store(workerBits, 0, ack[0]!);
          else store(worker64, 0, ack64[0]!);
        }
      }
      return count;
    };
  };
  const drain = makeDrain(decodeAt, false);

  return {
    encode,
    encodeMany,
    decode: () => drain() !== 0,
    makeDrain,
    loadPending,
    retireSteal,
    ack,
    host64,
    ack64,
    hasSpace: () => ((hostBits[0]! ^ ack[0]!) | (hostBits[1]! ^ ack[1]!)) !== 0,
    isCaughtUp: () => load(host64, 0) === ack64[0],
  };
};
