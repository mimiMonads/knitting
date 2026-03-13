import assert from "node:assert/strict";
import test from "node:test";

const assertEquals: (actual: unknown, expected: unknown) => void =
  (actual, expected) => {
    assert.deepStrictEqual(actual, expected);
  };

import { register } from "../src/memory/regionRegistry.ts";
import {
  LockBound,
  LOCK_SECTOR_BYTE_LENGTH,
  makeTask,
  TaskIndex,
} from "../src/memory/lock.ts";

const align64 = (n: number) => (n + 63) & ~63;
const SLOT_MASK = 31;

const popcount32 = (v: number) => {
  let x = v >>> 0;
  let c = 0;
  while (x !== 0) {
    x &= x - 1;
    c++;
  }
  return c;
};

const makeRng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
};

type LiveAlloc = { slot: number; start: number; size: number };

const assertNoOverlap = (live: Map<number, LiveAlloc>) => {
  const vals = Array.from(live.values());
  for (let i = 0; i < vals.length; i++) {
    const a = vals[i]!;
    const aEnd = a.start + a.size;
    for (let j = i + 1; j < vals.length; j++) {
      const b = vals[j]!;
      const bEnd = b.start + b.size;
      if (a.start < bEnd && b.start < aEnd) {
        assert.fail(
          `overlap: slot ${a.slot} [${a.start}..${aEnd}) vs slot ${b.slot} [${b.start}..${bEnd})`,
        );
      }
    }
  }
};

test("dual-register remains consistent under interleaved alloc/free workload", () => {
  const sharedLockSAB = new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);
  const encoder = register({ lockSector: sharedLockSAB });
  const decoder = register({ lockSector: sharedLockSAB });

  const nextRandom = makeRng(0xdeadbeef);
  const live = new Map<number, LiveAlloc>();
  let allocFailures = 0;
  let overlapCount = 0;
  let bitMismatch = 0;

  for (let step = 0; step < 5000; step++) {
    const shouldAlloc = live.size === 0 ||
      (live.size < LockBound.slots - 2 && (nextRandom() & 1) === 0);

    if (shouldAlloc) {
      encoder.updateTable();
      const payloadLen = 64 + (nextRandom() % 4096);
      const task = makeTask();
      task[TaskIndex.PayloadLen] = payloadLen;

      const result = encoder.allocTask(task);
      if (result === -1) {
        if (live.size < LockBound.slots) {
          allocFailures++;
        }
        continue;
      }

      const slot = task[TaskIndex.slotBuffer] & SLOT_MASK;
      const start = task[TaskIndex.Start];
      const size = align64(payloadLen);

      if (live.has(slot)) {
        overlapCount++;
      }

      live.set(slot, { slot, start, size });

      try {
        assertNoOverlap(live);
      } catch {
        overlapCount++;
      }
    } else {
      const slots = Array.from(live.keys());
      const slot = slots[nextRandom() % slots.length]!;
      decoder.free(slot);
      live.delete(slot);
    }

    const stateBits = (encoder.hostBits[0] ^ encoder.workerBits[0]) >>> 0;
    if (popcount32(stateBits) !== live.size) {
      bitMismatch++;
    }
  }

  for (const slot of live.keys()) {
    decoder.free(slot);
    live.delete(slot);
  }

  assertEquals(allocFailures, 0);
  assertEquals(overlapCount, 0);
  assertEquals(bitMismatch, 0);
});

test("single shared register: no desync under same workload", () => {
  const sharedLockSAB = new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);
  const shared = register({ lockSector: sharedLockSAB });

  const nextRandom = makeRng(0xdeadbeef);
  const live = new Map<number, LiveAlloc>();
  let allocFailures = 0;
  let overlapCount = 0;
  let bitMismatch = 0;

  for (let step = 0; step < 5000; step++) {
    const shouldAlloc = live.size === 0 ||
      (live.size < LockBound.slots - 2 && (nextRandom() & 1) === 0);

    if (shouldAlloc) {
      shared.updateTable();
      const payloadLen = 64 + (nextRandom() % 4096);
      const task = makeTask();
      task[TaskIndex.PayloadLen] = payloadLen;

      const result = shared.allocTask(task);
      if (result === -1) {
        if (live.size < LockBound.slots) {
          allocFailures++;
        }
        continue;
      }

      const slot = task[TaskIndex.slotBuffer] & SLOT_MASK;
      const start = task[TaskIndex.Start];
      const size = align64(payloadLen);

      if (live.has(slot)) {
        overlapCount++;
      }

      live.set(slot, { slot, start, size });
      assertNoOverlap(live);
    } else {
      const slots = Array.from(live.keys());
      const slot = slots[nextRandom() % slots.length]!;
      shared.free(slot);
      live.delete(slot);
    }

    const stateBits = (shared.hostBits[0] ^ shared.workerBits[0]) >>> 0;
    if (popcount32(stateBits) !== live.size) {
      bitMismatch++;
    }
  }

  for (const slot of live.keys()) {
    shared.free(slot);
    live.delete(slot);
  }

  assertEquals(allocFailures, 0);
  assertEquals(overlapCount, 0);
  assertEquals(bitMismatch, 0);
});

test("dual-register: bulk free then re-alloc works cleanly", () => {
  const sharedLockSAB = new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);
  const encoder = register({ lockSector: sharedLockSAB });
  const decoder = register({ lockSector: sharedLockSAB });
  const allocated: number[] = [];

  for (let i = 0; i < 30; i++) {
    const task = makeTask();
    task[TaskIndex.PayloadLen] = 64;
    const result = encoder.allocTask(task);
    assert.notStrictEqual(result, -1, `initial alloc ${i} failed`);
    allocated.push(task[TaskIndex.slotBuffer] & SLOT_MASK);
  }

  for (const slot of allocated) {
    decoder.free(slot);
  }

  encoder.updateTable();

  let reallocFail = 0;
  for (let i = 0; i < 30; i++) {
    const task = makeTask();
    task[TaskIndex.PayloadLen] = 64;
    if (encoder.allocTask(task) === -1) {
      reallocFail++;
    }
  }

  assertEquals(reallocFail, 0);
});

test("single register: bulk free then re-alloc works cleanly", () => {
  const sharedLockSAB = new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);
  const shared = register({ lockSector: sharedLockSAB });
  const allocated: number[] = [];

  for (let i = 0; i < 30; i++) {
    const task = makeTask();
    task[TaskIndex.PayloadLen] = 64;
    const result = shared.allocTask(task);
    assert.notStrictEqual(result, -1, `initial alloc ${i} failed`);
    allocated.push(task[TaskIndex.slotBuffer] & SLOT_MASK);
  }

  for (const slot of allocated) {
    shared.free(slot);
  }

  shared.updateTable();

  let reallocFail = 0;
  for (let i = 0; i < 30; i++) {
    const task = makeTask();
    task[TaskIndex.PayloadLen] = 64;
    if (shared.allocTask(task) === -1) {
      reallocFail++;
    }
  }

  assertEquals(reallocFail, 0);
});

test("dual-register: toggle bits match true live count", () => {
  const sharedLockSAB = new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);
  const encoder = register({ lockSector: sharedLockSAB });
  const decoder = register({ lockSector: sharedLockSAB });

  let maxDivergence = 0;
  const live = new Set<number>();

  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 8; i++) {
      encoder.updateTable();
      const task = makeTask();
      task[TaskIndex.PayloadLen] = 128;
      if (encoder.allocTask(task) !== -1) {
        live.add(task[TaskIndex.slotBuffer] & SLOT_MASK);
      }
    }

    const slots = Array.from(live);
    for (let i = 0; i < Math.min(4, slots.length); i++) {
      decoder.free(slots[i]!);
      live.delete(slots[i]!);
    }

    encoder.updateTable();

    const stateBits = (encoder.hostBits[0] ^ encoder.workerBits[0]) >>> 0;
    const bitCount = popcount32(stateBits);
    const divergence = Math.abs(bitCount - live.size);
    if (divergence > maxDivergence) maxDivergence = divergence;
  }

  assertEquals(maxDivergence, 0);
});
