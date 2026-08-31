import {
  LOCK_SECTOR_BYTE_LENGTH,
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

/** Dynamic payload-region identities; independent from 32 queue header slots. */
export const DYNAMIC_PAYLOAD_SLOTS = 64;
export const DYNAMIC_PAYLOAD_SLOT_MASK = DYNAMIC_PAYLOAD_SLOTS - 1;

const PAYLOAD_LOCK_STATE_WORDS = DYNAMIC_PAYLOAD_SLOTS / 32;

// Low 6 bits store the region index; the remaining bits store its byte offset.
const EMPTY = 0xFFFFFFBF >>> 0; // 111...10111111
const SLOT_META_PACKED_MASK = (~TASK_SLOT_INDEX_MASK) >>> 0;

export type RegisterMalloc = ReturnType<typeof register>;

export const register = (
  {
    lockSector,
  }: {
    lockSector?: SharedBufferSource;
  },
) => {
  const lockRegion = toSharedBufferRegion(
    lockSector ?? createWasmSharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
  );
  const lockSAB = lockRegion.sab;

  // Dynamic-region state shares the queue lock's cache-line padding.
  const hostBits = new Int32Array(
    lockSAB,
    lockRegion.byteOffset + PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES,
    PAYLOAD_LOCK_STATE_WORDS,
  );
  const workerBits = new Int32Array(
    lockSAB,
    lockRegion.byteOffset + PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
    PAYLOAD_LOCK_STATE_WORDS,
  );

  const startAndIndex = new Uint32Array(DYNAMIC_PAYLOAD_SLOTS);
  const size64bit = new Uint32Array(DYNAMIC_PAYLOAD_SLOTS);
  // Keep region offsets indexed by slot for O(1) lookup.
  const startBySlot = new Uint32Array(DYNAMIC_PAYLOAD_SLOTS);

  const a_load = Atomics.load;
  const a_store = Atomics.store;
  const a_xor = Atomics.xor;

  const SLOT_MASK = DYNAMIC_PAYLOAD_SLOT_MASK;
  const START_MASK = (~SLOT_MASK) >>> 0;

  startAndIndex.fill(EMPTY);

  let tableLength = 0;
  // Keep the common <=32-region path in scalar words.
  let usedBits0 = 0 | 0;
  let usedBits1 = 0 | 0;
  let hostLast0 = 0 | 0;
  let hostLast1 = 0 | 0;

  const startAndIndexToArray = (length: number) =>
    startAndIndex.slice(0, length);

  const slotWord = (slot: number) => slot >>> 5;
  const slotBit = (slot: number) => 1 << (slot & 31);

  const compactFreed = (freeBits0: number, freeBits1: number) => {
    const sai = startAndIndex;
    let write = 0;

    for (let read = 0; read < tableLength; read++) {
      const value = sai[read]!;
      const slot = value & SLOT_MASK;
      const freeBits = slot < 32 ? freeBits0 : freeBits1;
      if ((freeBits & slotBit(slot)) !== 0) continue;
      if (write !== read) sai[write] = value;
      write++;
    }

    for (let at = write; at < tableLength; at++) sai[at] = EMPTY;
    tableLength = write;
  };

  const findFreeSlot = (): number => {
    let available = ~usedBits0;
    if (available !== 0) {
      return 31 - Math.clz32((available & -available) >>> 0);
    }
    available = ~usedBits1;
    return available === 0
      ? -1
      : 32 + 31 - Math.clz32((available & -available) >>> 0);
  };

  /** Store the sixth region-index bit in bit 31 of the task length word. */
  const tagTaskSlot = (task: Task, slot: number) => {
    task[TaskIndex.End] = (
      (task[TaskIndex.End] & 0x7FFFFFFF) | ((slot & 32) << 26)
    ) >>> 0;
  };

  const reserveSlot = (slot: number) => {
    const bit = slotBit(slot);
    if (slot < 32) {
      usedBits0 = (usedBits0 | bit) | 0;
      hostLast0 = (hostLast0 ^ bit) | 0;
      a_store(hostBits, 0, hostLast0);
    } else {
      usedBits1 = (usedBits1 | bit) | 0;
      hostLast1 = (hostLast1 ^ bit) | 0;
      a_store(hostBits, 1, hostLast1);
    }
  };

  // Reconcile completed reads and remove freed regions from the table.
  const updateTable = () => {
    if (tableLength === 0) return;

    const freeBits0 = usedBits0 === 0
      ? 0
      : (~(hostLast0 ^ a_load(workerBits, 0)) & usedBits0) | 0;
    const freeBits1 = usedBits1 === 0
      ? 0
      : (~(hostLast1 ^ a_load(workerBits, 1)) & usedBits1) | 0;
    if ((freeBits0 | freeBits1) === 0) return;

    if (freeBits0 === usedBits0 && freeBits1 === usedBits1) {
      tableLength = 0;
      usedBits0 = 0;
      usedBits1 = 0;
      return;
    }

    usedBits0 = (usedBits0 & ~freeBits0) | 0;
    usedBits1 = (usedBits1 & ~freeBits1) | 0;
    compactFreed(freeBits0, freeBits1);
  };

  // The extent table stays sorted by offset and is limited to 64 regions.
  const findAndInsert = (size: number): number => {
    updateTable();

    if (tableLength >= DYNAMIC_PAYLOAD_SLOTS) return -1;
    const slot = findFreeSlot();
    if (slot === -1) return -1;

    let previousEnd = 0;
    let insertAt = tableLength;
    for (let at = 0; at < tableLength; at++) {
      const value = startAndIndex[at]!;
      const start = value & START_MASK;
      if (((start - previousEnd) >>> 0) >= (size >>> 0)) {
        insertAt = at;
        break;
      }
      previousEnd = (start + (size64bit[value & SLOT_MASK] >>> 0)) >>> 0;
    }

    for (let at = tableLength; at > insertAt; at--) {
      startAndIndex[at] = startAndIndex[at - 1]!;
    }
    startAndIndex[insertAt] = (previousEnd | slot) >>> 0;
    size64bit[slot] = size >>> 0;
    startBySlot[slot] = previousEnd >>> 0;
    tableLength++;
    reserveSlot(slot);
    return slot;
  };

  /**
   * Reserve a region for `payloadLen` bytes without a task to stamp it into.
   * Returns the region index, or -1 when every identity is taken. Its offset is
   * `regionStart(slot)`.
   */
  const allocRegion = (payloadLen: number): number =>
    findAndInsert(((payloadLen | 0) + 63) & ~63);

  /** Byte offset of a region reserved by `allocRegion` or `allocTask`. */
  const regionStart = (slot: number): number =>
    startBySlot[slot & SLOT_MASK]!;

  const allocTask = (task: Task) => {
    const slot = findAndInsert(((task[TaskIndex.PayloadLen] | 0) + 63) & ~63);
    if (slot === -1) return -1;
    task[TaskIndex.Start] = startBySlot[slot]!;
    task[TaskIndex.slotBuffer] = (
      (task[TaskIndex.slotBuffer] & SLOT_META_PACKED_MASK) |
      (slot & TASK_SLOT_INDEX_MASK)
    ) >>> 0;
    tagTaskSlot(task, slot);
    return slot;
  };

  const setSlotLength = (slotIndex: number, payloadLen: number) => {
    const slot = slotIndex & SLOT_MASK;
    size64bit[slot] = (((payloadLen | 0) + 63) & ~63) >>> 0;
    return true;
  };

  // XOR preserves independent release toggles from encode and decode paths.
  const free = (index: number) => {
    const slot = index & SLOT_MASK;
    a_xor(workerBits, slotWord(slot), slotBit(slot));
  };

  return {
    allocTask,
    allocRegion,
    regionStart,
    setSlotLength,
    tagTaskSlot,
    lockSAB,
    free,
    hostBits,
    workerBits,
    updateTable,
    startAndIndexToArray,
  };
};
