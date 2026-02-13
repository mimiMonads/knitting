import {
  LockBound,
  LOCK_HOST_BITS_OFFSET_BYTES,
  LOCK_SECTOR_BYTE_LENGTH,
  LOCK_WORKER_BITS_OFFSET_BYTES,
  TaskIndex,
} from "./lock.ts";
import type { Task } from "./lock.ts";


export type RegisterMalloc = ReturnType<typeof register>;

export const register = ({ lockSector }: { lockSector?: SharedArrayBuffer }) => {
  const lockSAB =
    lockSector ??
    new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);

  const hostBits = new Int32Array(lockSAB, LOCK_HOST_BITS_OFFSET_BYTES, 1);
  const workerBits = new Int32Array(lockSAB, LOCK_WORKER_BITS_OFFSET_BYTES, 1);

  const startAndIndex = new Uint32Array(LockBound.slots);
  const size64bit = new Uint32Array(LockBound.slots);

  // Atomics aliases (hot path)
  const a_load = Atomics.load;
  const a_store = Atomics.store;
  // Uint32Array method alias (hot path)
  const saiCopyWithin = startAndIndex.copyWithin.bind(startAndIndex);

  const clz32 = Math.clz32;

  const EMPTY = 0xFFFFFFFF >>> 0;
  const SLOT_MASK = 31;
  const START_MASK = (~SLOT_MASK) >>> 0;

  startAndIndex.fill(EMPTY);

  let tableLength = 0;
  let usedBits = 0 | 0;

  // scalar state (faster than Uint32Array(1))
  let hostLast = 0 | 0;
  let workerLast = 0 | 0;

  // cheaper modulo-8 counter
  let updateTableCounter = 0;

  const startAndIndexToArray = (length: number) =>
    Array.from(startAndIndex.subarray(0, length));

  const compactSectorStable = (b: number) => {
    const sai = startAndIndex;
    let w = 0 | 0;
    let r = 0 | 0;

    b = b | 0;

    for (; r + 3 < b; r += 4) {
      const v0 = sai[r];
      const v1 = sai[r + 1];
      const v2 = sai[r + 2];
      const v3 = sai[r + 3];

      if (v0 !== EMPTY) sai[w++] = v0;
      if (v1 !== EMPTY) sai[w++] = v1;
      if (v2 !== EMPTY) sai[w++] = v2;
      if (v3 !== EMPTY) sai[w++] = v3;
    }

    for (; r < b; r++) {
      const v = sai[r];
      if (v !== EMPTY) sai[w++] = v;
    }

    return w;
  };

  const updateTable = () => {
    // state = which bits are currently "in use" under toggle-protocol
    const w = a_load(workerBits, 0) | 0;
    const state = (hostLast ^ w) >>> 0;

    // freeBits = bits where host/worker agree (toggle resolved)
    let freeBits = (~state) >>> 0;

    if (tableLength === 0 || freeBits === 0) return;

    // all cleared
    if (freeBits === EMPTY) {
      tableLength = 0;
      usedBits = 0 | 0;
      return;
    }

    // only bother with bits we actually consider used
    freeBits &= usedBits;
    if (freeBits === 0) return;

    const sai = startAndIndex;

    for (let i = 0; i < tableLength; i++) {
      const v = sai[i];
      if (v === EMPTY) continue;

      // if this slot is now free, clear entry
      if ((freeBits & (1 << (v & SLOT_MASK))) !== 0) {
        sai[i] = EMPTY;
      }
    }

    usedBits &= ~freeBits;
    tableLength = compactSectorStable(tableLength);
  };

  const allocTask = (task: Task) => {
    // update every 4 allocs, using bitmask counter
    updateTableCounter = (updateTableCounter + 1) & 3;
    if (updateTableCounter === 0) updateTable();

    // align payload length to 64 bytes
    const payloadLen = task[TaskIndex.PayloadLen] | 0;
    const size = (payloadLen + 63) & ~63;

    // inline loadFreeBit()
    const freeBits = (~usedBits) >>> 0;
    const freeBit = (freeBits & -freeBits) >>> 0;

    if (freeBit === 0) return -1;
    if (tableLength >= LockBound.slots) return -1;

    const slotIndex = 31 - clz32(freeBit);

    const sai = startAndIndex;
    const sz = size64bit;
    const tl = tableLength;

    // ========= FAST PATH: empty table =========
    if (tl === 0) {
      sai[0] = slotIndex;
      sz[slotIndex] = size;

      task[TaskIndex.Start] = 0;
      task[TaskIndex.slotBuffer] = slotIndex;

      tableLength = 1;
      usedBits |= freeBit;

      hostLast ^= freeBit;
      return a_store(hostBits, 0, hostLast);
    }

    // ========= gap at beginning =========
    const firstStart = sai[0] & START_MASK;
    if (firstStart >= (size >>> 0)) {
      // shift right by 1 (native memmove)
      saiCopyWithin(1, 0, tl);

      sai[0] = slotIndex;
      sz[slotIndex] = size;

      task[TaskIndex.Start] = 0;
      task[TaskIndex.slotBuffer] = slotIndex;

      tableLength = tl + 1;
      usedBits |= freeBit;

      hostLast ^= freeBit;
      return a_store(hostBits, 0, hostLast);
    }

    // ========= search for a gap between entries =========
    for (let at = 0; at + 1 < tl; at++) {
      const cur = sai[at];

      const curStart = cur & START_MASK;
      const curEnd = (curStart + (sz[cur & SLOT_MASK] >>> 0)) >>> 0;

      const nextStart = sai[at + 1] & START_MASK;

      // gap >= size ?
      if ((nextStart - curEnd) >>> 0 < (size >>> 0)) continue;

      // shift right from (at+1) to insert at (at+1)
      saiCopyWithin(at + 2, at + 1, tl);

      sai[at + 1] = (curEnd | slotIndex) >>> 0;
      sz[slotIndex] = size;

      task[TaskIndex.Start] = curEnd;
      task[TaskIndex.slotBuffer] = slotIndex;

      tableLength = tl + 1;
      usedBits |= freeBit;

      hostLast ^= freeBit;
      return a_store(hostBits, 0, hostLast);
    }

    // ========= append at end =========
    if (tl < LockBound.slots) {
      const last = sai[tl - 1];

      const lastStart = last & START_MASK;
      const newStart = (lastStart + (sz[last & SLOT_MASK] >>> 0)) >>> 0;

      sai[tl] = (newStart | slotIndex) >>> 0;
      sz[slotIndex] = size;

      task[TaskIndex.Start] = newStart;
      task[TaskIndex.slotBuffer] = slotIndex;

      tableLength = tl + 1;
      usedBits |= freeBit;

      hostLast ^= freeBit;
      return a_store(hostBits, 0, hostLast);
    }

    return -1;
  };

  const setSlotLength = (slotIndex: number, payloadLen: number) => {
    if ((slotIndex | 0) < 0 || slotIndex >= LockBound.slots) return false;

    const bit = 1 << slotIndex;
    if ((usedBits & bit) === 0) return false;

    const current = size64bit[slotIndex] >>> 0;
    const aligned = ((payloadLen | 0) + 63) & ~63;
    if (aligned < 0) return false;
    if ((aligned >>> 0) > current) return false;

    size64bit[slotIndex] = aligned >>> 0;
    return true;
  };

  const free = (index: number) => {
    workerLast ^= 1 << index;
    a_store(workerBits, 0, workerLast);
  };

  return {
    allocTask,
    setSlotLength,
    lockSAB,
    free,
    hostBits,
    workerBits,
    updateTable,
    startAndIndexToArray,
  };
};
