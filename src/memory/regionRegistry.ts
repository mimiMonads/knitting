import {
  LockBound,
  LOCK_SECTOR_BYTE_LENGTH,
  PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES,
  PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
  TASK_SLOT_INDEX_MASK,
  TaskIndex,
} from "./lock.ts";
import type { Task } from "./lock.ts";
import { createWasmSharedArrayBuffer } from "../common/runtime.ts";
import {
  toSharedBufferRegion,
  type SharedBufferSource,
} from "../common/shared-buffer-region.ts";

// Low 5 bits = slot index, high 27 bits = caller meta.
// Inlined from setTaskSlotIndex to avoid cross-closure call on hot path.
const SLOT_META_PACKED_MASK = 0xFFFFFFE0; // (~0x1F) >>> 0


export type RegisterMalloc = ReturnType<typeof register>;

export const register = ({ lockSector }: { lockSector?: SharedBufferSource }) => {
  const lockRegion = toSharedBufferRegion(
    lockSector ?? createWasmSharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
  );
  const lockSAB = lockRegion.sab;

  const hostBits = new Int32Array(
    lockSAB,
    lockRegion.byteOffset + PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES,
    1,
  );
  const workerBits = new Int32Array(
    lockSAB,
    lockRegion.byteOffset + PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
    1,
  );

  const startAndIndex = new Uint32Array(LockBound.slots);
  const size64bit = new Uint32Array(LockBound.slots);

  const clz32 = Math.clz32;

  const EMPTY = 0xFFFFFFFF >>> 0;
  const SLOT_MASK = TASK_SLOT_INDEX_MASK;
  const START_MASK = (~SLOT_MASK) >>> 0;

  startAndIndex.fill(EMPTY);

  let tableLength = 0;
  let usedBits = 0 | 0;

  // scalar state (faster than Uint32Array(1))
  let hostLast = 0 | 0;
  let workerLast = 0 | 0;

  const startAndIndexToArray = (length: number) =>
    startAndIndex.slice(0, length);

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
    const w =   Atomics.load(workerBits, 0) | 0;
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

  // Hot-path allocation: reconcile frees, optionally reuse an exact-fit freed
  // region in place, otherwise compact survivors while looking for the first gap.
  const findAndInsert = (task: Task, size: number): number => {
    const sai = startAndIndex;
    const sz = size64bit;
    let tl = tableLength;
    let insertAt = -1;
    let insertStart = 0;
    let prevEnd = 0;
    let didCompactScan = false;

    if (tl === 0 && usedBits === 0) {
      sai[0] = 0;
      sz[0] = size;
      task[TaskIndex.Start] = 0;
      task[TaskIndex.slotBuffer] =
        ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | 0) >>> 0;
      tableLength = 1;
      usedBits = 1;
      hostLast ^= 1;
      return 0;
    }

    if (tl !== 0) {
      const w = Atomics.load(workerBits, 0) | 0;
      let freeBits = (~(hostLast ^ w)) >>> 0;
      if (freeBits !== 0) freeBits &= usedBits;

       if (freeBits === EMPTY) {
        tableLength = 0;
        usedBits = 0 | 0;
        tl = 0;
      } else if (freeBits !== 0) {
        for (let i = 0; i < tl; i++) {
          const v = sai[i];
          const reclaimedSlot = v & SLOT_MASK;
          const reclaimedBit = 1 << reclaimedSlot;
          if ((freeBits & reclaimedBit) === 0) continue;
          if ((sz[reclaimedSlot] >>> 0) !== (size >>> 0)) continue;

          const availableBits = (~usedBits) >>> 0;
          const freeBit = (availableBits & -availableBits) >>> 0;
          if (freeBit === 0) return -1;

          const slotIndex = 31 - clz32(freeBit);
          const start = v & START_MASK;
          sai[i] = (start | slotIndex) >>> 0;
          sz[slotIndex] = size;
          task[TaskIndex.Start] = start;
          task[TaskIndex.slotBuffer] =
            ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
          usedBits = (usedBits & ~reclaimedBit) | freeBit;
          hostLast ^= freeBit;
          return slotIndex;
        }
      }
      if (tl !== 0 && freeBits !== 0 && freeBits !== EMPTY) {
        didCompactScan = true;
        let write = 0;
        for (let read = 0; read < tl; read++) {
          const v = sai[read];
          const slot = v & SLOT_MASK;

          if ((freeBits & (1 << slot)) !== 0) continue;

          const curStart = v & START_MASK;
          if (insertAt === -1 && ((curStart - prevEnd) >>> 0) >= (size >>> 0)) {
            insertAt = write;
            insertStart = prevEnd;
          }

          if (write !== read) sai[write] = v;
          write++;
          prevEnd = (curStart + (sz[slot] >>> 0)) >>> 0;
        }

        if (freeBits !== 0) usedBits &= ~freeBits;
        tableLength = tl = write;
      }
    }

    if (tl >= LockBound.slots) return -1;

    const availableBits = (~usedBits) >>> 0;
    const freeBit = (availableBits & -availableBits) >>> 0;
    if (freeBit === 0) return -1;

    const slotIndex = 31 - clz32(freeBit);

    if (!didCompactScan && tl !== 0) {
      const firstStart = sai[0] & START_MASK;
      if (firstStart >= (size >>> 0)) {
        for (let i = tl; i > 0; i--) sai[i] = sai[i - 1]!;
        sai[0] = slotIndex;
        sz[slotIndex] = size;
        task[TaskIndex.Start] = 0;
        task[TaskIndex.slotBuffer] =
          ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
        tableLength = tl + 1;
        usedBits |= freeBit;
        hostLast ^= freeBit;
        return slotIndex;
      }

      for (let at = 0; at + 1 < tl; at++) {
        const cur = sai[at];
        const curStart = cur & START_MASK;
        const curEnd = (curStart + (sz[cur & SLOT_MASK] >>> 0)) >>> 0;
        const nextStart = sai[at + 1] & START_MASK;

        if ((nextStart - curEnd) >>> 0 < (size >>> 0)) continue;

        for (let i = tl; i > at + 1; i--) sai[i] = sai[i - 1]!;
        sai[at + 1] = (curEnd | slotIndex) >>> 0;
        sz[slotIndex] = size;
        task[TaskIndex.Start] = curEnd;
        task[TaskIndex.slotBuffer] =
          ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
        tableLength = tl + 1;
        usedBits |= freeBit;
        hostLast ^= freeBit;
        return slotIndex;
      }

      const last = sai[tl - 1];
      const lastStart = last & START_MASK;
      const newStart = (lastStart + (sz[last & SLOT_MASK] >>> 0)) >>> 0;
      sai[tl] = (newStart | slotIndex) >>> 0;
      sz[slotIndex] = size;
      task[TaskIndex.Start] = newStart;
      task[TaskIndex.slotBuffer] =
        ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
      tableLength = tl + 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }

    if (tl === 0) {
      sai[0] = slotIndex;
      sz[slotIndex] = size;
      task[TaskIndex.Start] = 0;
      task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
      tableLength = 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }

    if (insertAt !== -1) {
      for (let i = tl; i > insertAt; i--) sai[i] = sai[i - 1]!;
      sai[insertAt] = (insertStart | slotIndex) >>> 0;
      sz[slotIndex] = size;
      task[TaskIndex.Start] = insertStart;
      task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
      tableLength = tl + 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }

    sai[tl] = (prevEnd | slotIndex) >>> 0;
    sz[slotIndex] = size;
    task[TaskIndex.Start] = prevEnd;
    task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
    tableLength = tl + 1;
    usedBits |= freeBit;
    hostLast ^= freeBit;
    return slotIndex;
  };


  const allocTask = (task: Task) => {
    const payloadLen = task[TaskIndex.PayloadLen] | 0;
    const size = (payloadLen + 63) & ~63;

    const slotIndex = findAndInsert(task, size);
    //if (slotIndex === -1) return -1;

    // Publish slot ownership changes with atomic visibility for the peer.
    //Atomics.store(hostBits, 0, hostLast);
    hostBits[0] = hostLast
    return slotIndex;
  };

  const setSlotLength = (slotIndex: number, payloadLen: number) => {
    slotIndex = slotIndex & TASK_SLOT_INDEX_MASK;

    //const bit = 1 << slotIndex;
    //if ((usedBits & bit) === 0) return false;

    //const current = size64bit[slotIndex] >>> 0;
    const aligned = ((payloadLen | 0) + 63) & ~63;
    //if (aligned < 0) return false;
    //if ((aligned >>> 0) > current) return false;

    size64bit[slotIndex] = aligned >>> 0;
    return true;
  };

  const free = (index: number) => {
    index = index & TASK_SLOT_INDEX_MASK;
    workerLast ^= 1 << index;
    // Publish frees atomically so the allocator sees the updated toggle state.
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