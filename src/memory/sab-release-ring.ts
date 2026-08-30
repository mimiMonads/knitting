import { createSharedArrayBuffer } from "../common/runtime.ts";
import {
  type SharedBufferSource,
  toSharedBufferRegion,
} from "../common/shared-buffer-region.ts";

// Host -> worker channel returning borrowed SAB slab tokens to their producer.
//
// One SPSC ring per worker: the host is the only writer, the owning worker the
// only reader. A token is a u64 written as two u32 words, so a slot is 2 words.
// Losing a token leaks a slab, so a full ring never drops: the host parks the
// overflow in a JS queue and republishes on the next publish or flush.

const HEADER_U32 = 16; // one cache line, keeps write/read indices apart
const WRITE_INDEX = 0;
const READ_INDEX = 8;
const WORDS_PER_SLOT = 2;

export const DEFAULT_SAB_RELEASE_RING_SLOTS = 1024;

const toPowerOfTwo = (value: number): number => {
  let size = 2;
  while (size < value) size <<= 1;
  return size;
};

export const sabReleaseRingByteLength = (
  slots = DEFAULT_SAB_RELEASE_RING_SLOTS,
): number =>
  (HEADER_U32 + toPowerOfTwo(slots) * WORDS_PER_SLOT) *
  Uint32Array.BYTES_PER_ELEMENT;

export const createSabReleaseRingBuffer = (
  slots = DEFAULT_SAB_RELEASE_RING_SLOTS,
): SharedArrayBuffer => createSharedArrayBuffer(sabReleaseRingByteLength(slots));

type RingViews = {
  readonly index: Int32Array;
  readonly body: Uint32Array;
  readonly mask: number;
};

const viewsOf = (sab: SharedBufferSource): RingViews => {
  const region = toSharedBufferRegion(sab);
  const index = new Int32Array(region.sab, region.byteOffset, HEADER_U32);
  const bodyWords = (region.byteLength >>> 2) - HEADER_U32;
  const body = new Uint32Array(
    region.sab,
    region.byteOffset + HEADER_U32 * Uint32Array.BYTES_PER_ELEMENT,
    bodyWords,
  );
  const slots = bodyWords / WORDS_PER_SLOT;
  if (slots < 2 || (slots & (slots - 1)) !== 0) {
    throw new RangeError("SAB release ring slot count must be a power of two");
  }
  return { index, body, mask: slots - 1 };
};

const a_load = Atomics.load;
const a_store = Atomics.store;

/** Host end: publish tokens the producing worker may now unpin. */
export const createSabReleasePublisher = (sab: SharedBufferSource) => {
  const { index, body, mask } = viewsOf(sab);
  const capacity = mask + 1;
  // Tokens that did not fit; drained before any new token so order is kept.
  const overflow: number[] = [];
  let write = a_load(index, WRITE_INDEX) >>> 0;

  const tryWrite = (low: number, high: number): boolean => {
    const read = a_load(index, READ_INDEX) >>> 0;
    if (((write - read) >>> 0) >= capacity) return false;
    const at = (write & mask) * WORDS_PER_SLOT;
    body[at] = low;
    body[at + 1] = high;
    write = (write + 1) >>> 0;
    return true;
  };

  const flushOverflow = (): boolean => {
    while (overflow.length > 0) {
      if (!tryWrite(overflow[0]!, overflow[1]!)) return false;
      overflow.splice(0, 2);
    }
    return true;
  };

  /** Queue `token` for release. Never drops; returns false when it had to park. */
  const publish = (token: bigint): boolean => {
    const low = Number(token & 0xffffffffn) >>> 0;
    const high = Number((token >> 32n) & 0xffffffffn) >>> 0;
    const drained = flushOverflow();
    const written = drained && tryWrite(low, high);
    if (!written) overflow.push(low, high);
    a_store(index, WRITE_INDEX, write | 0);
    return written;
  };

  /** Retry parked tokens; call when the ring may have drained. */
  const flush = (): boolean => {
    if (overflow.length === 0) return true;
    const drained = flushOverflow();
    a_store(index, WRITE_INDEX, write | 0);
    return drained;
  };

  return {
    publish,
    flush,
    get pending(): number {
      return overflow.length / WORDS_PER_SLOT;
    },
  };
};

export type SabReleasePublisher = ReturnType<typeof createSabReleasePublisher>;

/** Worker end: drain tokens the host has finished with. */
export const createSabReleaseConsumer = (sab: SharedBufferSource) => {
  const { index, body, mask } = viewsOf(sab);
  let read = a_load(index, READ_INDEX) >>> 0;

  /** Invoke `onToken` for every published token; returns how many were drained. */
  const drain = (onToken: (token: bigint) => void): number => {
    const write = a_load(index, WRITE_INDEX) >>> 0;
    let drained = 0;
    while (read !== write) {
      const at = (read & mask) * WORDS_PER_SLOT;
      const token = (BigInt(body[at + 1]! >>> 0) << 32n) |
        BigInt(body[at]! >>> 0);
      read = (read + 1) >>> 0;
      drained++;
      onToken(token);
    }
    if (drained > 0) a_store(index, READ_INDEX, read | 0);
    return drained;
  };

  const hasPending = (): boolean =>
    (a_load(index, WRITE_INDEX) >>> 0) !== read;

  return { drain, hasPending };
};

export type SabReleaseConsumer = ReturnType<typeof createSabReleaseConsumer>;
