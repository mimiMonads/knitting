import {
  LockBound,
  LOCK_HOST_BITS_OFFSET_BYTES,
  LOCK_SECTOR_BYTE_LENGTH,
  LOCK_WORKER_BITS_OFFSET_BYTES,
  TASK_SLOT_INDEX_MASK,
  TaskIndex,
} from "./lock.ts";
import type { Task } from "./lock.ts";

// Low 5 bits = slot index, high 27 bits = caller meta.
// Inlined from setTaskSlotIndex to avoid cross-closure call on hot path.
const SLOT_META_PACKED_MASK = 0xFFFFFFE0; // (~0x1F) >>> 0


export type RegisterMalloc = ReturnType<typeof register>;

export const register = ({ lockSector }: { lockSector?: SharedArrayBuffer }) => {
  const lockSAB =
    lockSector ??
    new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);

  const hostBits = new Int32Array(lockSAB, LOCK_HOST_BITS_OFFSET_BYTES, 1);
  const workerBits = new Int32Array(lockSAB, LOCK_WORKER_BITS_OFFSET_BYTES, 1);

  const startAndIndex = new Uint32Array(LockBound.slots);
  const size64bit = new Uint32Array(LockBound.slots);

  const clz32 = Math.clz32;

  const EMPTY = 0xFFFFFFFF >>> 0;
  const SLOT_MASK = TASK_SLOT_INDEX_MASK;
  const U32_LIMIT = 0x1_0000_0000;

  startAndIndex.fill(EMPTY);

  let tableLength = 0;
  let usedBits = 0 | 0;

  // scalar state (faster than Uint32Array(1))
  let hostLast = 0 | 0;
  let workerLast = 0 | 0;

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
    const w = Atomics.load(workerBits, 0) | 0;
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

  // Pure computation: find a slot and write task fields. No Atomics.
  // Returns slotIndex on success, -1 on failure.
  const findAndInsert = (task: Task, size: number): number => {
    const freeBits = (~usedBits) >>> 0;
    const freeBit = (freeBits & -freeBits) >>> 0;

    if (freeBit === 0) return -1;

    const tl = tableLength;
    if (tl >= LockBound.slots) return -1;

    const slotIndex = 31 - clz32(freeBit);
    const sai = startAndIndex;
    const sz = size64bit;
    const sizeU32 = size >>> 0;

    // inlined setTaskSlotIndex: task[6] = (task[6] & ~0x1F) | slotIndex
    // avoids cross-closure call on every hot path branch

    // ========= FAST PATH: empty table =========
    if (tl === 0) {
      sai[0] = slotIndex;
      sz[slotIndex] = sizeU32;
      task[TaskIndex.Start] = 0;
      task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
      tableLength = 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }

    // ========= gap at beginning =========
    const first = sai[0];
    const firstStart = first - (first & SLOT_MASK);
    if (firstStart >= sizeU32) {
      sai.copyWithin(1, 0, tl);
      sai[0] = slotIndex;
      sz[slotIndex] = sizeU32;
      task[TaskIndex.Start] = 0;
      task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
      tableLength = tl + 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }

    // ========= search for a gap between entries =========
    for (let at = 0; at + 1 < tl; at++) {
      const cur = sai[at];
      const curSlot = cur & SLOT_MASK;
      const curStart = cur - curSlot;
      const curEndRaw = curStart + sz[curSlot];
      const curEnd = curEndRaw < U32_LIMIT ? curEndRaw : curEndRaw - U32_LIMIT;
      const next = sai[at + 1];
      const nextStart = next - (next & SLOT_MASK);

      if ((nextStart - curEnd) >>> 0 < sizeU32) continue;

      sai.copyWithin(at + 2, at + 1, tl);
      sai[at + 1] = curEnd + slotIndex;
      sz[slotIndex] = sizeU32;
      task[TaskIndex.Start] = curEnd;
      task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
      tableLength = tl + 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }

    // ========= append at end =========
    if (tl < LockBound.slots) {
      const last = sai[tl - 1];
      const lastSlot = last & SLOT_MASK;
      const lastStart = last - lastSlot;
      const newStartRaw = lastStart + sz[lastSlot];
      const newStart = newStartRaw < U32_LIMIT
        ? newStartRaw
        : newStartRaw - U32_LIMIT;
      sai[tl] = newStart + slotIndex;
      sz[slotIndex] = sizeU32;
      task[TaskIndex.Start] = newStart;
      task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
      tableLength = tl + 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }

    return -1;
  };

  const allocTask = (task: Task) => {
    // Inlined updateTable() on the hot path to remove the extra closure call.
    {
      const w = Atomics.load(workerBits, 0) | 0;
      const state = (hostLast ^ w) >>> 0;
      let freeBits = (~state) >>> 0;

      if (tableLength !== 0 && freeBits !== 0) {
        if (freeBits === EMPTY) {
          tableLength = 0;
          usedBits = 0 | 0;
        } else {
          freeBits &= usedBits;

          if (freeBits !== 0) {
            const sai = startAndIndex;

            for (let i = 0; i < tableLength; i++) {
              const v = sai[i];
              if (v === EMPTY) continue;

              if ((freeBits & (1 << (v & SLOT_MASK))) !== 0) {
                sai[i] = EMPTY;
              }
            }

            usedBits &= ~freeBits;
            tableLength = compactSectorStable(tableLength);
          }
        }
      }
    }

    const payloadLen = task[TaskIndex.PayloadLen] | 0;
    const size = (payloadLen + 63) & ~63;

    const slotIndex = findAndInsert(task, size);
    if (slotIndex === -1) return -1;

    // single Atomics.store commit point — monomorphic call site
    Atomics.store(hostBits, 0, hostLast);
    return slotIndex;
  };

  const setSlotLength = (slotIndex: number, payloadLen: number) => {
    slotIndex = slotIndex & TASK_SLOT_INDEX_MASK;

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
    index = index & TASK_SLOT_INDEX_MASK;
    workerLast ^= 1 << index;
    Atomics.store(workerBits, 0, workerLast);
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
