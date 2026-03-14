import {
  LockBound,
  LOCK_SECTOR_BYTE_LENGTH,
  PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES,
  PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
  TASK_SLOT_INDEX_MASK,
  TaskIndex,
} from "./lock.ts";
import { createWasmSharedArrayBuffer } from "../common/runtime.ts";
import {
  toSharedBufferRegion,
  type SharedBufferSource,
} from "../common/shared-buffer-region.ts";
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
    Array.from(startAndIndex.subarray(0, length));

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
    let nextLength = 0 | 0;
    for (let i = 0; i < tableLength; i++) {
      const v = sai[i];
      if (v === EMPTY) continue;
      if ((freeBits & (1 << (v & SLOT_MASK))) !== 0) continue;
      sai[nextLength++] = v;
    }

    usedBits &= ~freeBits;
    tableLength = nextLength;
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

    // inlined setTaskSlotIndex: task[6] = (task[6] & ~0x1F) | slotIndex
    // avoids cross-closure call on every hot path branch

    // ========= FAST PATH: empty table =========
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

    // ========= gap at beginning =========
    const firstStart = sai[0] & START_MASK;
    if (firstStart >= (size >>> 0)) {
      sai.copyWithin(1, 0, tl);
      sai[0] = slotIndex;
      sz[slotIndex] = size;
      task[TaskIndex.Start] = 0;
      task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
      tableLength = tl + 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }

    // ========= search for a gap between entries =========
    let prevEnd =
      (firstStart + (sz[sai[0] & SLOT_MASK] >>> 0)) >>> 0;
    for (let at = 0; at + 1 < tl; at++) {
      const next = sai[at + 1];
      const nextStart = next & START_MASK;

      if ((nextStart - prevEnd) >>> 0 < (size >>> 0)) {
        prevEnd = (nextStart + (sz[next & SLOT_MASK] >>> 0)) >>> 0;
        continue;
      }

      sai.copyWithin(at + 2, at + 1, tl);
      sai[at + 1] = (prevEnd | slotIndex) >>> 0;
      sz[slotIndex] = size;
      task[TaskIndex.Start] = prevEnd;
      task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
      tableLength = tl + 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }

    // ========= append at end =========
    const last = sai[tl - 1];
    const lastStart = last & START_MASK;
    const newStart = (lastStart + (sz[last & SLOT_MASK] >>> 0)) >>> 0;
    sai[tl] = (newStart | slotIndex) >>> 0;
    sz[slotIndex] = size;
    task[TaskIndex.Start] = newStart;
    task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>> 0;
    tableLength = tl + 1;
    usedBits |= freeBit;
    hostLast ^= freeBit;
    return slotIndex;
  };

  const allocTask = (task: Task) => {
    // throttled table cleanup — kept outside findAndInsert so that
    // function stays pure (no calls, stable type feedback for TurboFan)
    updateTable();

    const payloadLen = task[TaskIndex.PayloadLen] | 0;
    const size = (payloadLen + 63) & ~63;

    const slotIndex = findAndInsert(task, size);
    if (slotIndex === -1) return -1;

    // single Atomics.store commit point — monomorphic call site
    //Atomics.store(hostBits, 0, hostLast);
    hostBits[0] = hostLast
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
    //Atomics.store(workerBits, 0, workerLast);
    workerBits[0] = workerLast
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
