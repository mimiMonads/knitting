import { withResolvers } from "../common/with-resolvers.ts";

const SLOT_BITS = 32;
const SLOT_MASK = SLOT_BITS - 1;
export const AbortSignalPoolExhausted = Symbol.for(
  "knitting.abortSignal.poolExhausted",
);
export const EnqueuedAbortSignal = Symbol.for(
  "knitting.abortSignal.enqueuedSignal",
);

export type SignalAbortStore = ReturnType<typeof signalAbortFactory>;
export type SetSignalResult = -1 | 0 | 1;

export const signalAbortFactory = ({
  sab,
}: {
  sab: SharedArrayBuffer;
}) => {
  const atomicView = new Uint32Array(sab);
  const size = atomicView.length;
  const inUse = new Uint32Array(size);
  const max = size * SLOT_BITS;
  const closeNow = max + 1;

  let current = 0;
  let cursor = 0;

  const getSignal = () => {
    if (current >= max ) return closeNow;

    for (let step = 0; step < size; step++) {
      const word = (cursor + step) % size;
      const freeBits = (~inUse[word]) >>> 0;
      if (freeBits === 0) continue;

      const bit = (freeBits & -freeBits) >>> 0;
      inUse[word] = (inUse[word] | bit) >>> 0;
      current = (current + 1) | 0;
      cursor = (word + 1) % size;

      // Recycled slot must start in "not aborted" state.
      Atomics.and(atomicView, word, ~bit);

      const bitIndex = 31 - Math.clz32(bit);
      return (word << 5) + bitIndex;
    }

    return closeNow;
  };

  const setSignal = (signal: number): SetSignalResult => {
    // 0 => sentinel "abort because pool/size is exhausted"
    if (signal === closeNow) return 0;
    // -1 => invalid signal id
    if (!Number.isInteger(signal)) return -1;
    if (signal < 0 || signal >= max) return -1;

    // 1 => signal bit was set as aborted
    const word = signal >>> 5;
    const bit = 1 << (signal & SLOT_MASK);
    Atomics.or(atomicView, word, bit);
    return 1;
  };

  const hasAborted = (signal: number) => {
    if (signal === closeNow) return true;
    if (!Number.isInteger(signal)) return false;
    if (signal < 0 || signal >= max) return false;

    const word = signal >>> 5;
    const bit = 1 << (signal & SLOT_MASK);
    return (Atomics.load(atomicView, word) & bit) !== 0;
  };

  const resetSignal = (signal: number) => {
    if (signal === closeNow) return false;
    if (!Number.isInteger(signal)) return false;
    if (signal < 0 || signal >= max) return false;

    const word = signal >>> 5;
    const bit = 1 << (signal & SLOT_MASK);
    const used = (inUse[word] & bit) !== 0;
    if (!used) return false;

    inUse[word] = (inUse[word] & ~bit) >>> 0;
    if (current > 0) current = (current - 1) | 0;
    cursor = word;

    // Clear aborted flag for future reuse.
    Atomics.and(atomicView, word, ~bit);
    return true;
  };

  return {
    max,
    closeNow,
    getSignal,
    setSignal,
    hasAborted,
    resetSignal,
    inUseCount: () => current,
  };
};


export class OneShotDeferred<T> {  

  #triggered = false;

  constructor(
    deferred: ReturnType<typeof withResolvers<T>>,
    onSettle: () => void,
  ) {

    const settleOnce = <A extends unknown[]>(
      fn: (...args: A) => void,
    ) =>
    (...args: A) => {
      if (this.#triggered) return;
      this.#triggered = true;
      onSettle();
      fn(...args);
    };

    deferred.resolve = settleOnce(deferred.resolve);
    deferred.reject = settleOnce(deferred.reject.bind(deferred.promise));
  }
}
