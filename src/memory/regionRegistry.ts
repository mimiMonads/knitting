import { LockBound, TaskIndex } from "./lock.ts";
import type { Task } from "./lock.ts";

export type RegisterMalloc = ReturnType<typeof register>;

export const register = ({ lockSector }: { lockSector?: SharedArrayBuffer }) => {
  // Cache constants (avoid module/property traffic in hot paths)
  const PADDING = LockBound.padding | 0;
  const SLOTS = LockBound.slots | 0;

  const lockSAB =
    lockSector ??
    new SharedArrayBuffer(PADDING * 3 + Int32Array.BYTES_PER_ELEMENT * 2);

  // Atomics want Int32Array for stable int32 pipeline
  const hostBits = new Int32Array(lockSAB, PADDING, 1);
  const workerBits = new Int32Array(lockSAB, PADDING * 2, 1);

  // Keep these int32: your domain is small (< 2^31), and EMPTY sentinel is -1.
  const startAndIndex = new Int32Array(SLOTS); // packed: (start | slot)
  const size64 = new Int32Array(SLOTS);        // aligned sizes (bytes), int32

  // Atomics aliases (monomorphic call sites)
  const a_load = Atomics.load;
  const a_store = Atomics.store;

  // Math alias (also monomorphic)
  const clz32 = Math.clz32;

  // Packed entry layout:
  // low 5 bits = slot (0..31)
  // remaining bits = start (multiple of 64 => lower 6 bits = 0, so low 5 are safe)
  const EMPTY = -1;         // 0xFFFF_FFFF
  const SLOT_MASK = 31;     // 0b11111
  const START_MASK = -32;   // 0xFFFF_FFE0 (clear low 5 bits)
  const ALIGN_MASK = -64;   // align to 64 bytes

  // Cache task indices (avoid enum object lookups in JS output)
  const IDX_PL = TaskIndex.PayloadLen | 0;
  const IDX_START = TaskIndex.Start | 0;
  const IDX_SLOTBUF = TaskIndex.slotBuffer | 0;

  startAndIndex.fill(EMPTY);

  // State
  let tableLength = 0 | 0;  // 0..32
  let usedBits = 0 | 0;     // int32 bitset: 1 means slot currently used
  let hostLast = 0 | 0;     // toggle protocol (host)
  let workerLast = 0 | 0;   // toggle protocol (worker)
  let updateCtr = 0 | 0;    // mod-8 counter

  // Single-pass: remove freed entries + compact
  const updateTable = () => {
    if ((tableLength | 0) === 0) return;

    const w = a_load(workerBits, 0) | 0;
    const state = (hostLast ^ w) | 0;

    // If host/worker agree on all bits, everything is resolved -> free all.
    if (state === 0) {
      tableLength = 0;
      usedBits = 0;
      return;
    }

    // Bits that are now free among those we believe used:
    // freeBits = (~state) & usedBits
    const freeBits = ((~state) & usedBits) | 0;
    if (freeBits === 0) return;

    const sai = startAndIndex;
    let widx = 0 | 0;

    // Keep stable order, just skip freed slots
    for (let r = 0; r < (tableLength | 0); r++) {
      const v = sai[r] | 0;
      if (v === EMPTY) continue;

      const bit = (1 << (v & SLOT_MASK)) | 0;
      if ((freeBits & bit) !== 0) continue; // freed -> drop

      sai[widx++] = v;
    }

    tableLength = widx | 0;
    usedBits = (usedBits & ~freeBits) | 0;
  };

  const allocTask = (task: Task) => {
    // update every 8 allocs
    updateCtr = (updateCtr + 1) & 7;
    if (updateCtr === 0) updateTable();

    // size aligned to 64 bytes (int32)
    const payloadLen = task[IDX_PL] | 0;
    const size = (payloadLen + 63) & ALIGN_MASK;

    // lowest free bit in ~usedBits
    const freeBits = (~usedBits) | 0;
    const freeBit = (freeBits & -freeBits) | 0;

    if (freeBit === 0) return -1;
    if ((tableLength | 0) >= SLOTS) return -1;

    const slotIndex = (31 - clz32(freeBit)) | 0;

    const sai = startAndIndex;
    const sz = size64;
    const tl = tableLength | 0;

    // ---- fast path: empty table ----
    if (tl === 0) {
      sai[0] = slotIndex;     // start=0
      sz[slotIndex] = size;

      task[IDX_START] = 0;
      task[IDX_SLOTBUF] = slotIndex;

      tableLength = 1;
      usedBits = (usedBits | freeBit) | 0;

      hostLast = (hostLast ^ freeBit) | 0;
      a_store(hostBits, 0, hostLast);
      return hostLast;
    }

    // ---- gap at beginning ----
    const firstStart = (sai[0] & START_MASK) | 0;
    if (firstStart >= size) {
      // shift right by 1 (tl <= 31)
      for (let i = tl; i > 0; i--) sai[i] = sai[i - 1];

      sai[0] = slotIndex;
      sz[slotIndex] = size;

      task[IDX_START] = 0;
      task[IDX_SLOTBUF] = slotIndex;

      tableLength = (tl + 1) | 0;
      usedBits = (usedBits | freeBit) | 0;

      hostLast = (hostLast ^ freeBit) | 0;
      a_store(hostBits, 0, hostLast);
      return hostLast;
    }

    // ---- search for gap between entries ----
    for (let at = 0; at + 1 < tl; at++) {
      const cur = sai[at] | 0;

      const curStart = (cur & START_MASK) | 0;
      const curSlot = (cur & SLOT_MASK) | 0;
      const curEnd = (curStart + (sz[curSlot] | 0)) | 0;

      const nextStart = (sai[at + 1] & START_MASK) | 0;
      if ((nextStart - curEnd) < size) continue;

      // shift right from (at+1) to insert at (at+1)
      for (let i = tl; i > at + 1; i--) sai[i] = sai[i - 1];

      sai[at + 1] = (curEnd | slotIndex) | 0;
      sz[slotIndex] = size;

      task[IDX_START] = curEnd;
      task[IDX_SLOTBUF] = slotIndex;

      tableLength = (tl + 1) | 0;
      usedBits = (usedBits | freeBit) | 0;

      hostLast = (hostLast ^ freeBit) | 0;
      a_store(hostBits, 0, hostLast);
      return hostLast;
    }

    // ---- append at end ----
    {
      const last = sai[tl - 1] | 0;
      const lastStart = (last & START_MASK) | 0;
      const lastSlot = (last & SLOT_MASK) | 0;
      const newStart = (lastStart + (sz[lastSlot] | 0)) | 0;

      sai[tl] = (newStart | slotIndex) | 0;
      sz[slotIndex] = size;

      task[IDX_START] = newStart;
      task[IDX_SLOTBUF] = slotIndex;

      tableLength = (tl + 1) | 0;
      usedBits = (usedBits | freeBit) | 0;

      hostLast = (hostLast ^ freeBit) | 0;
      a_store(hostBits, 0, hostLast);
      return hostLast;
    }
  };

  const free = (index: number) => {
    const bit = (1 << (index | 0)) | 0;
    workerLast = (workerLast ^ bit) | 0;
    a_store(workerBits, 0, workerLast);
  };

  // Debug helper (keep out of hot paths)
  const startAndIndexToArray = (length: number) =>
    Array.from(startAndIndex.subarray(0, length | 0));

  return {
    allocTask,
    lockSAB,
    free,
    hostBits,
    workerBits,
    updateTable,
    startAndIndexToArray,
  };
};
