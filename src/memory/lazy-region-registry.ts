/**
 * A payload-region registry with more than 64 identities and a lazy free set.
 *
 * Two independent changes from `regionRegistry.ts`:
 *
 * 1. **Width.** That registry packs `start | slot` into one Uint32 and steals
 *    the low 6 bits for the identity, which is exactly the 64-slot ceiling
 *    (regions are 64-byte aligned, so only 6 bits are spare). This one unpacks
 *    the table into `tableStart` + `tableSlot`, and its host-local
 *    `usedBits0/1` scalars become an Int32Array of `slots / 32` words plus a
 *    one-bit-per-word "this word still has a free identity" mask so the
 *    free-slot search stays O(1) instead of O(words).
 *
 * 2. **Laziness.** That registry's `findAndInsert` calls `updateTable()` on
 *    every allocation (an atomic load per word plus an O(tableLength)
 *    compaction) and then walks the sorted table for a first fit. `lazy` mode
 *    instead borrows the sender-shadow rule from `lock.ts`: reconcile only
 *    when the cached free set is exhausted. Staleness can only mark an already-free
 *    identity as busy, never a busy one as free, so a stale read costs
 *    capacity and never correctness -- the same false-busy-only property the
 *    queue's `ensureSenderStateHasFree` relies on.
 *
 *    Between reconciles the allocator is a bump pointer over the arena: append
 *    past the highest live region, O(1), no scan and no insert shift. Holes
 *    left by freed regions below the tail are reclaimed only when the bump
 *    window is exhausted (a reconcile, then a sorted first-fit) or when every
 *    identity has drained, which resets the arena to offset 0. That is the
 *    "old data is fine" trade: the allocator is eventually consistent with the
 *    real free set, and pays for it in arena high-water, not in correctness.
 */

import {
  LOCK_SECTOR_BYTE_LENGTH,
  PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES,
  PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
} from "./lock.ts";

/** Region alignment, matching the shipped registry. */
export const REGION_ALIGN = 64;

/** hostBits and workerBits each own one 64-byte line: 16 words = 512 slots. */
export const MAX_REGION_SLOTS = 512;

/**
 * Largest arena this registry will manage.
 *
 * Offsets and sizes are folded with int32 bitwise operators (the alignment
 * round-up, the bump-pointer compare), so an arena that reaches into the
 * unsigned range would wrap a size negative and let it pass a bound it should
 * have failed. Capping at 2 GiB minus one alignment unit keeps every
 * intermediate -- `byteLength + (REGION_ALIGN - 1)` included -- inside the
 * positive int32 range.
 */
export const MAX_ARENA_BYTE_LENGTH = 0x7fffffff - (REGION_ALIGN - 1);

export type LazyRegionRegistryMode = "eager" | "lazy";

export type LazyRegionRegistryOptions = {
  /** Region identities. Multiple of 32, up to `MAX_REGION_SLOTS`. */
  slots?: number;
  /**
   * `eager` reproduces the shipped policy at the new width: reconcile every
   * allocation, always sorted first-fit. `lazy` reconciles on exhaustion and
   * bump-allocates in between.
   */
  mode?: LazyRegionRegistryMode;
  /** Bump window before the allocator must reclaim holes. */
  arenaByteLength?: number;
  lockSector?: SharedArrayBuffer;
};

export type LazyRegionRegistry = ReturnType<typeof createLazyRegionRegistry>;

const clz32 = Math.clz32;
const a_load = Atomics.load;
const a_store = Atomics.store;
const a_xor = Atomics.xor;

/** Index of the lowest set bit. */
const ctz = (word: number): number => 31 - clz32((word & -word) >>> 0);

export const createLazyRegionRegistry = ({
  slots = 128,
  mode = "lazy",
  arenaByteLength = 64 * 1024 * 1024,
  lockSector,
}: LazyRegionRegistryOptions = {}) => {
  if (slots < 32 || slots > MAX_REGION_SLOTS || (slots & 31) !== 0) {
    throw new RangeError(
      `slots must be a multiple of 32 in [32, ${MAX_REGION_SLOTS}]`,
    );
  }
  if (
    !Number.isSafeInteger(arenaByteLength) || arenaByteLength < REGION_ALIGN ||
    arenaByteLength > MAX_ARENA_BYTE_LENGTH
  ) {
    throw new RangeError(
      `arenaByteLength must be an integer in ` +
        `[${REGION_ALIGN}, ${MAX_ARENA_BYTE_LENGTH}]`,
    );
  }

  const words = slots >>> 5;
  const lazy = mode === "lazy";

  /**
   * Identities are addressed by index, never by mask: `slots` is only required
   * to be a multiple of 32, so `slot & (slots - 1)` is a valid reduction only
   * when `slots` happens to be a power of two. At `slots: 96` it folded slot 32
   * onto slot 0, handing two live regions the same offset and the same release
   * bit. Callers pass identities this registry itself handed out, so an
   * out-of-range one is a bug worth surfacing rather than silently aliasing.
   */
  const assertSlot = (slot: number): number => {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= slots) {
      throw new RangeError(`region identity ${slot} outside 0..${slots - 1}`);
    }
    return slot;
  };

  const lockSAB = lockSector ?? new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);
  const hostBits = new Int32Array(
    lockSAB,
    PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES,
    words,
  );
  const workerBits = new Int32Array(
    lockSAB,
    PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
    words,
  );

  // Host-local shadows. `used` is the host's belief about live identities;
  // `hostLast` mirrors what the host has published into `hostBits`.
  const used = new Int32Array(words);
  const hostLast = new Int32Array(words);
  const freedScratch = new Int32Array(words);

  // One bit per word: set while that word still holds a free identity.
  const ALL_WORDS = words === 32 ? -1 : ((1 << words) - 1) | 0;
  let freeWordMask = ALL_WORDS;

  // Extent table, sorted by offset, unpacked so the identity is not confined
  // to the spare alignment bits of the offset.
  const tableStart = new Uint32Array(slots);
  const tableSlot = new Uint16Array(slots);
  let tableLength = 0;

  const startBySlot = new Uint32Array(slots);
  const sizeBySlot = new Uint32Array(slots);

  /** End of the highest live region: the bump pointer. */
  let tailEnd = 0;
  let highWater = 0;

  let reconciles = 0;
  let firstFits = 0;
  let resets = 0;
  let appends = 0;

  const findFreeSlot = (): number => {
    let mask = freeWordMask;
    while (mask !== 0) {
      const w = ctz(mask);
      const available = ~used[w]!;
      if (available !== 0) {
        const slot = (w << 5) + ctz(available);
        return slot < slots ? slot : -1;
      }
      freeWordMask = (freeWordMask & ~(1 << w)) | 0;
      mask = freeWordMask;
    }
    return -1;
  };

  const reserveSlot = (slot: number): void => {
    const w = slot >>> 5;
    const bit = (1 << (slot & 31)) | 0;
    used[w] = (used[w]! | bit) | 0;
    hostLast[w] = (hostLast[w]! ^ bit) | 0;
    a_store(hostBits, w, hostLast[w]!);
    if (~used[w]! === 0) freeWordMask = (freeWordMask & ~(1 << w)) | 0;
  };

  /**
   * Fold the consumer's release toggles into the host shadow. Returns true
   * when anything was reclaimed. This is the only place that reads the shared
   * words, so it is the only cost laziness removes from the alloc path.
   */
  const reconcile = (): boolean => {
    reconciles++;

    let anyFreed = 0;
    let stillUsed = 0;
    for (let w = 0; w < words; w++) {
      const live = used[w]!;
      if (live === 0) {
        freedScratch[w] = 0;
        continue;
      }
      const freed = (~(hostLast[w]! ^ a_load(workerBits, w)) & live) | 0;
      freedScratch[w] = freed;
      anyFreed |= freed;
      stillUsed |= (live & ~freed) | 0;
    }

    if (anyFreed === 0) return false;

    // Every identity drained: reset the arena instead of compacting.
    if (stillUsed === 0) {
      resets++;
      tableLength = 0;
      tailEnd = 0;
      used.fill(0);
      freeWordMask = ALL_WORDS;
      return true;
    }

    for (let w = 0; w < words; w++) {
      const freed = freedScratch[w]!;
      if (freed === 0) continue;
      used[w] = (used[w]! & ~freed) | 0;
      freeWordMask = (freeWordMask | (1 << w)) | 0;
    }

    let write = 0;
    for (let read = 0; read < tableLength; read++) {
      const slot = tableSlot[read]!;
      if ((freedScratch[slot >>> 5]! & (1 << (slot & 31))) !== 0) continue;
      if (write !== read) {
        tableStart[write] = tableStart[read]!;
        tableSlot[write] = slot;
      }
      write++;
    }
    tableLength = write;
    // Regions never overlap, so sorted by start is sorted by end.
    tailEnd = write === 0
      ? 0
      : (tableStart[write - 1]! + sizeBySlot[tableSlot[write - 1]!]!) >>> 0;
    return true;
  };

  /** O(1) append past the highest live region. */
  const append = (slot: number, size: number): number => {
    appends++;
    const start = tailEnd;
    tableStart[tableLength] = start;
    tableSlot[tableLength] = slot;
    tableLength++;
    tailEnd = start + size;
    if (tailEnd > highWater) highWater = tailEnd;
    startBySlot[slot] = start;
    sizeBySlot[slot] = size;
    reserveSlot(slot);
    return slot;
  };

  /** Sorted first fit over the holes left below the tail. */
  const firstFit = (slot: number, size: number): number => {
    firstFits++;
    let previousEnd = 0;
    let insertAt = tableLength;
    for (let at = 0; at < tableLength; at++) {
      const start = tableStart[at]!;
      if (((start - previousEnd) >>> 0) >= (size >>> 0)) {
        insertAt = at;
        break;
      }
      previousEnd = (start + sizeBySlot[tableSlot[at]!]!) >>> 0;
    }
    if (previousEnd + size > arenaByteLength) return -1;

    for (let at = tableLength; at > insertAt; at--) {
      tableStart[at] = tableStart[at - 1]!;
      tableSlot[at] = tableSlot[at - 1]!;
    }
    tableStart[insertAt] = previousEnd;
    tableSlot[insertAt] = slot;
    tableLength++;
    startBySlot[slot] = previousEnd;
    sizeBySlot[slot] = size;
    const end = previousEnd + size;
    if (end > tailEnd) tailEnd = end;
    if (end > highWater) highWater = end;
    reserveSlot(slot);
    return slot;
  };

  const allocRegion = (byteLength: number): number => {
    // `byteLength | 0` truncated instead of rejecting: a 2 GiB request wrapped
    // to a negative size, passed the arena bound it should have failed, and
    // left `tailEnd` negative for the life of the pool. Anything the arena
    // cannot hold is -1, which is the caller's signal to take the overflow
    // path -- the same answer it already gets when identities run out.
    if (
      !Number.isSafeInteger(byteLength) || byteLength < 0 ||
      byteLength > arenaByteLength
    ) {
      return -1;
    }
    const size = (byteLength + (REGION_ALIGN - 1)) & ~(REGION_ALIGN - 1);

    if (!lazy) reconcile();

    let slot = findFreeSlot();
    if (slot === -1) {
      if (!reconcile()) return -1;
      slot = findFreeSlot();
      if (slot === -1) return -1;
    }

    if (tableLength >= slots || (tailEnd + size) > arenaByteLength) {
      reconcile();
      slot = findFreeSlot();
      if (slot === -1 || tableLength >= slots) return -1;
    }

    if (lazy && (tailEnd + size) <= arenaByteLength) return append(slot, size);
    return firstFit(slot, size);
  };

  const regionStart = (slot: number): number => startBySlot[assertSlot(slot)]!;

  /**
   * Shrink a region to `byteLength`, returning its new aligned size.
   *
   * This is what makes a streamed body of unknown length affordable: reserve
   * an upper bound, fill it, then give back what was not used. When the region
   * is the tail allocation -- the common case, since it was just bump
   * allocated -- the bump pointer rewinds and nothing is wasted at all.
   * Otherwise the tail of the region simply becomes a hole, reclaimed on the
   * next reconcile like any other.
   *
   * Growing is not offered: it would have to relocate the bytes, which is the
   * copy the caller is trying to avoid.
   */
  const trimRegion = (slot: number, byteLength: number): number => {
    const index = assertSlot(slot);
    const current = sizeBySlot[index]!;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return current;
    const size = (byteLength + (REGION_ALIGN - 1)) & ~(REGION_ALIGN - 1);
    if (size >= current) return current;

    const start = startBySlot[index]!;
    if (start + current === tailEnd) tailEnd = start + size;
    sizeBySlot[index] = size;
    return size;
  };

  /**
   * The identity whose extent contains [offset, offset + byteLength), or -1.
   * Binary search over the offset-sorted extent table: exact, no side table to
   * maintain, and it accepts interior offsets so a subarray of a borrowed view
   * still resolves to its region.
   *
   * Under lazy mode the table can still list regions the consumer has already
   * released but the owner has not reconciled. That is deliberate: those bytes
   * are not reusable until the owner observes the release, so a view into one
   * is still valid.
   */
  const slotContaining = (offset: number, byteLength: number): number => {
    let lo = 0;
    let hi = tableLength - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const start = tableStart[mid]!;
      if (offset < start) {
        hi = mid - 1;
        continue;
      }
      const slot = tableSlot[mid]!;
      const end = start + sizeBySlot[slot]!;
      if (offset >= end) {
        lo = mid + 1;
        continue;
      }
      // Starts inside this region: it fits, or it runs past the extent.
      return offset + byteLength <= end ? slot : -1;
    }
    return -1;
  };

  /** Consumer-side release: one XOR toggle per region, as shipped. */
  const free = (slot: number): void => {
    const s = assertSlot(slot);
    a_xor(workerBits, s >>> 5, (1 << (s & 31)) | 0);
  };

  const stats = () => ({
    slots,
    mode,
    tableLength,
    tailEnd,
    highWater,
    reconciles,
    firstFits,
    appends,
    resets,
  });

  const resetStats = (): void => {
    reconciles = 0;
    firstFits = 0;
    appends = 0;
    resets = 0;
  };

  return {
    allocRegion,
    regionStart,
    trimRegion,
    slotContaining,
    free,
    reconcile,
    stats,
    resetStats,
    hostBits,
    workerBits,
    lockSAB,
  };
};
