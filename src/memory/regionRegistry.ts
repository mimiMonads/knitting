import {
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES,
  PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
  TASK_SLOT_INDEX_MASK,
  TaskIndex,
} from "./lock.ts";
import type { Task } from "./lock.ts";
import { createWasmSharedArrayBuffer } from "../common/runtime.ts";
import {
  type SharedBufferSource,
  toSharedBufferRegion,
} from "../common/shared-buffer-region.ts";

// Low 5 bits = slot index, high 27 bits = caller meta.
// Inlined from setTaskSlotIndex to avoid cross-closure call on hot path.
const SLOT_META_PACKED_MASK = 0xFFFFFFE0; // (~0x1F) >>> 0

export type RegisterMalloc = ReturnType<typeof register>;

export const register = (
  { lockSector }: { lockSector?: SharedBufferSource },
) => {
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

  let startAndIndex = new Uint32Array(LockBound.slots);
  let scratchStartAndIndex = new Uint32Array(LockBound.slots);
  const size64bit = new Uint32Array(LockBound.slots);

  const clz32 = Math.clz32;

  const EMPTY = 0xFFFFFFFF >>> 0;
  const HOLE_APPEND_LIMIT = 5;
  const QUEUE_MASK = LockBound.slots - 1;
  const SLOT_MASK = TASK_SLOT_INDEX_MASK;
  const START_MASK = (~SLOT_MASK) >>> 0;

  let queueHead = 0;
  let queueLength = 0;
  let usedBits = 0 | 0;
  let queuedBits = 0 | 0;
  let holeBits = 0 | 0;
  let holeCount = 0;
  let frontHoleCount = 0;
  let hasFrontGap = false;
  let hasLayoutGap = false;
  let isChain = true;
  let tailEnd = 0;

  // scalar state (faster than Uint32Array(1))
  let hostLast = 0 | 0;
  let workerLast = 0 | 0;
  let workerSeen = 0 | 0;

  const popcount32 = (value: number) => {
    let x = value >>> 0;
    let count = 0;
    while (x !== 0) {
      x &= x - 1;
      count++;
    }
    return count;
  };

  const startAndIndexToArray = (length: number) => {
    const out = new Uint32Array(length);
    out.fill(EMPTY);

    let write = 0;
    for (let read = 0; read < queueLength && write < length; read++) {
      const packed = startAndIndex[(queueHead + read) & QUEUE_MASK]!;
      const slot = packed & SLOT_MASK;
      if ((usedBits & (1 << slot)) === 0) continue;
      out[write++] = packed;
    }

    return out;
  };

  const clearQueues = () => {
    queueHead = 0;
    queueLength = 0;
    usedBits = 0 | 0;
    queuedBits = 0 | 0;
    holeBits = 0 | 0;
    holeCount = 0;
    frontHoleCount = 0;
    hasFrontGap = false;
    hasLayoutGap = false;
    isChain = true;
    tailEnd = 0;
  };

  const refreshTailEnd = () => {
    if (queueLength === 0) {
      tailEnd = 0;
      return;
    }

    const packed = startAndIndex[(queueHead + queueLength - 1) & QUEUE_MASK]!;
    const slot = packed & SLOT_MASK;
    tailEnd = ((packed & START_MASK) + (size64bit[slot] >>> 0)) >>> 0;
  };

  const trimDeadHead = () => {
    let shifted = false;
    let shiftedHoles = 0;

    while (queueLength !== 0) {
      const packed = startAndIndex[queueHead]!;
      const slot = packed & SLOT_MASK;
      const bit = 1 << slot;
      if ((usedBits & bit) !== 0) break;

      queueHead = (queueHead + 1) & QUEUE_MASK;
      queueLength--;
      queuedBits &= ~bit;
      if ((holeBits & bit) !== 0) {
        holeBits &= ~bit;
        holeCount--;
        shiftedHoles++;
      }
      shifted = true;
    }

    if (queueLength === 0) {
      clearQueues();
      return;
    }

    if (shifted) {
      frontHoleCount += shiftedHoles;
      hasFrontGap = ((startAndIndex[queueHead]! & START_MASK) >>> 0) !== 0;
      isChain = false;
    }
  };

  const trimDeadTail = () => {
    while (queueLength !== 0) {
      const packed = startAndIndex[(queueHead + queueLength - 1) & QUEUE_MASK]!;
      const slot = packed & SLOT_MASK;
      const bit = 1 << slot;
      if ((usedBits & bit) !== 0) break;

      queueLength--;
      queuedBits &= ~bit;
      if ((holeBits & bit) !== 0) {
        holeBits &= ~bit;
        holeCount--;
      }
    }

    if (queueLength === 0) {
      clearQueues();
      return;
    }

    refreshTailEnd();
  };

  const rebuildQueue = (
    insert?: {
      task: Task;
      size: number;
      slotIndex: number;
      freeBit: number;
    },
  ) => {
    const source = startAndIndex;
    const sourceHead = queueHead;
    const sourceLength = queueLength;
    const target = scratchStartAndIndex;
    let write = 0;
    let prevEnd = 0;
    let inserted = typeof insert === "undefined";

    for (let read = 0; read < sourceLength; read++) {
      const packed = source[(sourceHead + read) & QUEUE_MASK]!;
      const slot = packed & SLOT_MASK;
      const bit = 1 << slot;
      if ((usedBits & bit) === 0) continue;

      const currentStart = packed & START_MASK;
      if (
        !inserted &&
        ((currentStart - prevEnd) >>> 0) >= (insert!.size >>> 0)
      ) {
        target[write++] = (prevEnd | insert!.slotIndex) >>> 0;
        insert!.task[TaskIndex.Start] = prevEnd;
        insert!.task[TaskIndex.slotBuffer] =
          ((insert!.task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) |
            insert!.slotIndex) >>> 0;
        inserted = true;
      }

      target[write++] = packed;
      prevEnd = (currentStart + (size64bit[slot] >>> 0)) >>> 0;
    }

    if (!inserted) {
      target[write++] = (prevEnd | insert!.slotIndex) >>> 0;
      insert!.task[TaskIndex.Start] = prevEnd;
      insert!.task[TaskIndex.slotBuffer] =
        ((insert!.task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) |
          insert!.slotIndex) >>> 0;
      prevEnd = (prevEnd + insert!.size) >>> 0;
    }

    const previous = startAndIndex;
    startAndIndex = scratchStartAndIndex;
    scratchStartAndIndex = previous;

    queueHead = 0;
    queueLength = write;
    if (typeof insert !== "undefined") {
      size64bit[insert.slotIndex] = insert.size >>> 0;
      usedBits |= insert.freeBit;
    }
    queuedBits = usedBits;
    holeBits = 0 | 0;
    holeCount = 0;
    frontHoleCount = 0;
    hasFrontGap = false;

    let nextTailEnd = 0;
    let nextHasLayoutGap = false;
    for (let i = 0; i < queueLength; i++) {
      const packed = startAndIndex[i]!;
      const slot = packed & SLOT_MASK;
      const currentStart = packed & START_MASK;
      if (i === 0) {
        hasFrontGap = (currentStart >>> 0) !== 0;
      } else if ((currentStart >>> 0) !== (nextTailEnd >>> 0)) {
        nextHasLayoutGap = true;
      }
      nextTailEnd = (currentStart + (size64bit[slot] >>> 0)) >>> 0;
    }

    hasLayoutGap = nextHasLayoutGap || hasFrontGap;
    isChain = !hasLayoutGap;
    tailEnd = nextTailEnd >>> 0;
  };

  const reconcileFrees = () => {
    const w = Atomics.load(workerBits, 0) | 0;
    if (w === workerSeen && isChain) return;

    const state = (hostLast ^ w) >>> 0;
    const freeBits = (~state) >>> 0;
    const reclaimedBits = freeBits & usedBits;
    workerSeen = w;

    if (reclaimedBits !== 0) {
      usedBits &= ~reclaimedBits;
      holeBits |= reclaimedBits;
      holeCount += popcount32(reclaimedBits);
      isChain = false;
    }

    trimDeadHead();
    if (queueLength === 0) return;

    trimDeadTail();
    if (queueLength === 0) return;

    if ((holeCount + frontHoleCount) >= HOLE_APPEND_LIMIT) {
      rebuildQueue();
    }
  };

  const updateTable = () => {
    reconcileFrees();
  };

  // Hot-path allocation: keep pushing while the queue only has a few holes and
  // there are still untouched slot ids left. Once holes build up, compact live
  // entries into the scratch queue and insert during the rebuild.
  const findAndInsert = (task: Task, size: number): number => {
    reconcileFrees();

    const availableBits = (~usedBits) >>> 0;
    if (availableBits === 0) return -1;

    if (queueLength === 0 && usedBits === 0) {
      const freeBit = (availableBits & -availableBits) >>> 0;
      const slotIndex = 31 - clz32(freeBit);

      startAndIndex[0] = slotIndex >>> 0;
      size64bit[slotIndex] = size;
      task[TaskIndex.Start] = 0;
      task[TaskIndex.slotBuffer] =
        ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>>
        0;
      queueHead = 0;
      queueLength = 1;
      usedBits = freeBit;
      queuedBits = freeBit;
      holeBits = 0;
      holeCount = 0;
      frontHoleCount = 0;
      hasFrontGap = false;
      hasLayoutGap = false;
      isChain = true;
      tailEnd = size >>> 0;
      hostLast ^= freeBit;
      return slotIndex;
    }

    if (isChain) {
      const freeBit = (availableBits & -availableBits) >>> 0;
      const slotIndex = 31 - clz32(freeBit);

      startAndIndex[(queueHead + queueLength) & QUEUE_MASK] =
        (tailEnd | slotIndex) >>> 0;
      size64bit[slotIndex] = size;
      task[TaskIndex.Start] = tailEnd;
      task[TaskIndex.slotBuffer] =
        ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>>
        0;
      queueLength++;
      usedBits |= freeBit;
      queuedBits |= freeBit;
      tailEnd = (tailEnd + size) >>> 0;
      hostLast ^= freeBit;
      return slotIndex;
    }

    const virginBits = (availableBits & (~queuedBits >>> 0)) >>> 0;
    if (
      !hasLayoutGap &&
      (holeCount + frontHoleCount) < HOLE_APPEND_LIMIT &&
      virginBits !== 0
    ) {
      const freeBit = (virginBits & -virginBits) >>> 0;
      const slotIndex = 31 - clz32(freeBit);

      startAndIndex[(queueHead + queueLength) & QUEUE_MASK] =
        (tailEnd | slotIndex) >>> 0;
      size64bit[slotIndex] = size;
      task[TaskIndex.Start] = tailEnd;
      task[TaskIndex.slotBuffer] =
        ((task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) | slotIndex) >>>
        0;
      queueLength++;
      usedBits |= freeBit;
      queuedBits |= freeBit;
      tailEnd = (tailEnd + size) >>> 0;
      hostLast ^= freeBit;
      return slotIndex;
    }

    const freeBit = (availableBits & -availableBits) >>> 0;
    if (freeBit === 0) return -1;

    const slotIndex = 31 - clz32(freeBit);
    rebuildQueue({
      task,
      size,
      slotIndex,
      freeBit,
    });
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
    hostBits[0] = hostLast;
    return slotIndex;
  };

  const setSlotLength = (slotIndex: number, payloadLen: number) => {
    slotIndex = slotIndex & TASK_SLOT_INDEX_MASK;

    //const bit = 1 << slotIndex;
    //if ((usedBits & bit) === 0) return false;

    const current = size64bit[slotIndex] >>> 0;
    const aligned = ((payloadLen | 0) + 63) & ~63;
    //if (aligned < 0) return false;
    //if ((aligned >>> 0) > current) return false;

    size64bit[slotIndex] = aligned >>> 0;
    if (aligned !== current && queueLength !== 0) {
      const last = startAndIndex[(queueHead + queueLength - 1) & QUEUE_MASK]!;
      if ((last & SLOT_MASK) === slotIndex && (usedBits & (1 << slotIndex)) !== 0) {
        tailEnd = ((last & START_MASK) + aligned) >>> 0;
      } else if (aligned < current && (usedBits & (1 << slotIndex)) !== 0) {
        hasLayoutGap = true;
        isChain = false;
      }
    }
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
