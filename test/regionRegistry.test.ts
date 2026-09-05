import assert from "node:assert/strict";
import test from "./_runner.ts";
const assertEquals: (actual: unknown, expected: unknown) => void = (
  actual,
  expected,
) => {
  assert.deepStrictEqual(actual, expected);
};
import {
  DYNAMIC_PAYLOAD_SLOT_MASK,
  DYNAMIC_PAYLOAD_SLOTS,
  register,
} from "../src/memory/regionRegistry.ts";
import {
  LOCK_CACHE_LINE_BYTES,
  LOCK_HOST_BITS_OFFSET_BYTES,
  LOCK_SECTOR_BYTE_LENGTH,
  LOCK_WORKER_BITS_OFFSET_BYTES,
  LockBound,
  makeTask,
  PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES,
  PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
  TaskIndex,
} from "../src/memory/lock.ts";

const align64 = (n: number) => (n + 63) & ~63;
const START_MASK = (~DYNAMIC_PAYLOAD_SLOT_MASK) >>> 0;
const EMPTY = 0xFFFFFFBF >>> 0;

const makeRegistry = () =>
  register({
    lockSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
  });

test("registry uses separate words inside the shared lock sector", () => {
  const lockSector = new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);
  const registry = register({ lockSector });
  const mainHostBits = new Int32Array(
    lockSector,
    LOCK_HOST_BITS_OFFSET_BYTES,
    1,
  );
  const mainWorkerBits = new Int32Array(
    lockSector,
    LOCK_WORKER_BITS_OFFSET_BYTES,
    1,
  );

  assert.equal(registry.hostBits.buffer, lockSector);
  assert.equal(registry.workerBits.buffer, lockSector);
  assert.equal(
    registry.hostBits.byteOffset,
    PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES,
  );
  assert.equal(
    registry.workerBits.byteOffset,
    PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
  );
  assert.equal(mainHostBits.byteOffset, LOCK_HOST_BITS_OFFSET_BYTES);
  assert.equal(mainWorkerBits.byteOffset, LOCK_WORKER_BITS_OFFSET_BYTES);
  assert.equal(LOCK_HOST_BITS_OFFSET_BYTES, 0);
  assert.equal(LOCK_WORKER_BITS_OFFSET_BYTES, LOCK_CACHE_LINE_BYTES);
  assert.equal(PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES, LOCK_CACHE_LINE_BYTES * 2);
  assert.equal(
    PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
    LOCK_CACHE_LINE_BYTES * 3,
  );
  assert.equal(LOCK_SECTOR_BYTE_LENGTH, LOCK_CACHE_LINE_BYTES * 4);
});

test("registry caps dynamic regions at 64 without widening queue slots", () => {
  const registry = makeRegistry();
  const tasks: ReturnType<typeof makeTask>[] = [];

  for (let slot = 0; slot < DYNAMIC_PAYLOAD_SLOTS; slot++) {
    const task = makeTask();
    task[TaskIndex.PayloadLen] = 64;
    task[TaskIndex.End] = 23;
    task[TaskIndex.slotBuffer] = 0xCAFE0000;
    assertEquals(registry.allocTask(task), slot);
    assertEquals(task[TaskIndex.slotBuffer] >>> 5, 0xCAFE0000 >>> 5);
    assertEquals(dynamicSlotOf(task), slot);
    assertEquals(task[TaskIndex.End] & 0x7FFFFFFF, 23);
    tasks.push(task);
  }

  const overflow = makeTask();
  overflow[TaskIndex.PayloadLen] = 64;
  assertEquals(registry.allocTask(overflow), -1);

  for (const task of tasks) registry.free(dynamicSlotOf(task));
  registry.updateTable();
});

const track64andIndex = (
  startAndIndex: number,
) => [startAndIndex >>> 6, startAndIndex & DYNAMIC_PAYLOAD_SLOT_MASK];
const dynamicSlotOf = (task: ReturnType<typeof makeTask>): number =>
  (task[TaskIndex.slotBuffer] & 31) | ((task[TaskIndex.End] >>> 31) << 5);
const allocNoSync = (
  registry: ReturnType<typeof makeRegistry>,
  size: number,
) => {
  const task = makeTask();
  task[TaskIndex.PayloadLen] = size;
  registry.allocTask(task);
  return task;
};
const tableSnapshot = (
  registry: ReturnType<typeof makeRegistry>,
  length: number,
) => Array.from(registry.startAndIndexToArray(length));
const expectedStartAndIndex = (
  sizes: number[],
) => [
  [0, 0],
  ...sizes.map((_, i, a) => {
    const val = a.slice(0, i + 1).reduce(
      (acc, c) => acc + (align64(c) >>> 6),
      0,
    );
    return [val, ++i];
  }).slice(0, -1),
];

const isSingleBit = (value: number) =>
  value !== 0 && (value & (value - 1)) === 0;

const popcount32 = (value: number) => {
  let x = value >>> 0;
  let count = 0;
  while (x !== 0) {
    x &= x - 1;
    count++;
  }
  return count;
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

type LiveAllocation = {
  start: number;
  size: number;
};

const assertNoOverlap = (live: Map<number, LiveAllocation>) => {
  const values = Array.from(live.values());
  for (let i = 0; i < values.length; i++) {
    const a = values[i]!;
    const aEnd = a.start + a.size;
    for (let j = i + 1; j < values.length; j++) {
      const b = values[j]!;
      const bEnd = b.start + b.size;
      const overlap = a.start < bEnd && b.start < aEnd;
      assertEquals(overlap, false);
    }
  }
};

const assertAllocatorInvariants = (
  registry: ReturnType<typeof makeRegistry>,
  live: Map<number, LiveAllocation>,
) => {
  let stateCount = 0;
  for (let word = 0; word < registry.hostBits.length; word++) {
    stateCount += popcount32(
      (registry.hostBits[word]! ^ registry.workerBits[word]!) >>> 0,
    );
  }
  assertEquals(stateCount, live.size);
  assertEquals(live.size <= DYNAMIC_PAYLOAD_SLOTS, true);

  const table = live.size === 0 ? [] : registry.startAndIndexToArray(live.size);
  const seenSlots = new Set<number>();

  for (const packed of table) {
    const slot = packed & DYNAMIC_PAYLOAD_SLOT_MASK;
    assertEquals(seenSlots.has(slot), false);
    seenSlots.add(slot);

    const expected = live.get(slot);
    assertEquals(typeof expected !== "undefined", true);
    assertEquals((packed & START_MASK) >>> 0, expected!.start >>> 0);
  }

  assertEquals(table.length, live.size);
  for (let slot = 0; slot < DYNAMIC_PAYLOAD_SLOTS; slot++) {
    const state = (registry.hostBits[slot >>> 5]! ^
      registry.workerBits[slot >>> 5]!) & (1 << (slot & 31));
    assertEquals(state !== 0, live.has(slot));
  }
  assertNoOverlap(live);
};

test("check packing in startAndIndexToArray", () => {
  const registry = makeRegistry();
  const sizes = [634, 43, 152, 54];

  const result = [
    [0, 0],
    ...sizes.map((_, i, a) => {
      // add them together and index [position + padding , index]
      const val = a.slice(0, i + 1).reduce(
        (acc, c) => acc + (align64(c) >>> 6),
        0,
      );
      return [val, ++i];
    }).slice(0, -1),
  ];

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  assertEquals(
    tableSnapshot(registry, sizes.length).map(track64andIndex),
    result,
  );
});

test("updateTable delete front", () => {
  const registry = makeRegistry();
  const sizes = [634, 64, 64, 64, 64, 64];
  const toBeDeletedFront = 2;

  const result = [
    [0, 0],
    ...sizes.map((_, i, a) => {
      // add them together and index [position + padding , index]
      const val = a.slice(0, i + 1).reduce(
        (acc, c) => acc + (align64(c) >>> 6),
        0,
      );
      return [val, ++i];
    }).slice(0, -1),
  ];

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  assertEquals(
    tableSnapshot(registry, sizes.length).map(track64andIndex),
    result,
  );

  registry.free(0);
  registry.free(1);
  registry.updateTable();
  result.splice(0, toBeDeletedFront);

  assertEquals(
    tableSnapshot(registry, sizes.length - toBeDeletedFront).map(
      track64andIndex,
    ),
    result,
  );
});

test("updateTable delete Back", () => {
  const registry = makeRegistry();
  const sizes = [64, 64, 64, 64, 64, 64];
  const toBeDeletedBack = 2;

  const result = [
    [0, 0],
    ...sizes.map((_, i, a) => {
      // add them together and index [position + padding , index]
      const val = a.slice(0, i + 1).reduce(
        (acc, c) => acc + (align64(c) >>> 6),
        0,
      );
      return [val, ++i];
    }).slice(0, -1),
  ];

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  assertEquals(
    tableSnapshot(registry, sizes.length).map(track64andIndex),
    result,
  );

  registry.free(4);
  registry.free(5);
  registry.updateTable();
  result.splice(-toBeDeletedBack);

  assertEquals(
    tableSnapshot(registry, sizes.length - toBeDeletedBack).map(
      track64andIndex,
    ),
    result,
  );
});

test("updateTable delete middle", () => {
  const registry = makeRegistry();
  const sizes = [64, 64, 64, 64, 64, 64];
  const toBeDeletedBack = 2;

  const result = [
    [0, 0],
    ...sizes.map((_, i, a) => {
      // add them together and index [position + padding , index]
      const val = a.slice(0, i + 1).reduce(
        (acc, c) => acc + (align64(c) >>> 6),
        0,
      );
      return [val, ++i];
    }).slice(0, -1),
  ];

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  assertEquals(
    tableSnapshot(registry, sizes.length).map(track64andIndex),
    result,
  );

  registry.free(1);
  registry.free(2);
  registry.updateTable();
  result.splice(1, toBeDeletedBack);

  assertEquals(
    tableSnapshot(registry, sizes.length - toBeDeletedBack).map(
      track64andIndex,
    ),
    result,
  );
});

test("check Start from Task", () => {
  const registry = makeRegistry();
  const sizes = [64, 453, 64, 64];
  const values = [];

  const result = sizes.reduce((acc, v) => (
    // reduce and adding padding and  >>> 6
    acc.push(acc[acc.length - 1] + align64(v)), acc
  ), [0]).slice(0, -1);

  for (const size of sizes) {
    values.push(allocNoSync(registry, size)[TaskIndex.Start]);
  }

  assertEquals(values, result);
});

test("allocTask preserves append offsets past signed integer range", () => {
  const registry = makeRegistry();
  const payloadLen = 70_000_001;
  const stride = align64(payloadLen);
  const tasks = Array.from({ length: LockBound.slots }, () => {
    const task = makeTask();
    task[TaskIndex.PayloadLen] = payloadLen;
    assertEquals(registry.allocTask(task) === -1, false);
    return task;
  });

  for (let i = 0; i < tasks.length; i++) {
    assertEquals(tasks[i]![TaskIndex.Start], stride * i);
  }

  assertEquals(tasks[tasks.length - 1]![TaskIndex.Start] > 0x7FFFFFFF, true);
});

test("packing boundary at payload size 63", () => {
  const registry = makeRegistry();
  const sizes = [63, 1];

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  assertEquals(
    tableSnapshot(registry, sizes.length).map(track64andIndex),
    expectedStartAndIndex(sizes),
  );
});

test("updateTable clears freed index >= 5", () => {
  const registry = makeRegistry();
  const sizes = Array.from({ length: 7 }, () => 64);

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  registry.free(5);
  registry.updateTable();

  const result = expectedStartAndIndex(sizes);
  result.splice(5, 1);

  assertEquals(
    tableSnapshot(registry, sizes.length - 1).map(track64andIndex),
    result,
  );
});

test("updateTable compacts survivors and clears the trailing freed slots", () => {
  const registry = makeRegistry();
  [64, 64, 64, 64].forEach((size) => {
    allocNoSync(registry, size);
  });

  registry.free(1);
  registry.free(3);
  registry.updateTable();

  const snapshot = tableSnapshot(registry, 4);
  assertEquals(snapshot.slice(0, 2).map(track64andIndex), [
    [0, 0],
    [2, 2],
  ]);
  assertEquals(snapshot[2], EMPTY);
  assertEquals(snapshot[3], EMPTY);
});

test("allocTask reuses freed gap", () => {
  const registry = makeRegistry();
  const sizes = [64, 64, 64];
  sizes.map((size) => allocNoSync(registry, size));

  registry.free(1);
  registry.updateTable();

  const task = makeTask();
  task[TaskIndex.PayloadLen] = 64;
  registry.allocTask(task);

  assertEquals(task[TaskIndex.Start], 64);
});

test("allocTask compacts survivors before appending past a freed gap", () => {
  const registry = makeRegistry();
  [64, 64, 64].forEach((size) => {
    allocNoSync(registry, size);
  });

  registry.free(1);

  const task = makeTask();
  task[TaskIndex.PayloadLen] = 128;
  registry.allocTask(task);

  const snapshot = tableSnapshot(registry, 4);
  assertEquals(task[TaskIndex.Start], 192);
  assertEquals(snapshot.slice(0, 3).map(track64andIndex), [
    [0, 0],
    [2, 2],
    [3, 1],
  ]);
  assertEquals(snapshot[3], EMPTY);
});

test("periodic compaction can reuse a freed gap during allocTask", () => {
  const registry = makeRegistry();
  [64, 64, 64].forEach((size) => allocNoSync(registry, size));

  registry.free(1);

  const task = makeTask();
  task[TaskIndex.PayloadLen] = 64;
  registry.allocTask(task);

  assertEquals(task[TaskIndex.Start], 64);
});

test("updateTable reuses freed slots in gaps and at start", () => {
  const registry = makeRegistry();
  [64, 64, 64, 64].map((size) => allocNoSync(registry, size));

  registry.free(0);
  registry.free(2);
  registry.updateTable();

  const first = makeTask();
  first[TaskIndex.PayloadLen] = 64;
  registry.allocTask(first);

  const second = makeTask();
  second[TaskIndex.PayloadLen] = 64;
  registry.allocTask(second);

  assertEquals(first[TaskIndex.Start], 0);
  assertEquals(second[TaskIndex.Start], 128);
});

test("updateTable resets usedBits when all slots freed", () => {
  const registry = makeRegistry();
  allocNoSync(registry, 64);
  allocNoSync(registry, 64);

  registry.free(0);
  registry.free(1);
  registry.updateTable();

  const task = makeTask();
  task[TaskIndex.PayloadLen] = 64;
  registry.allocTask(task);

  assertEquals(task[TaskIndex.Start], 0);
});

test("allocTask keeps appending contiguously after clear and tail-only frees", () => {
  const registry = makeRegistry();

  const first = allocNoSync(registry, 64);
  const second = allocNoSync(registry, 128);

  registry.free(dynamicSlotOf(first));
  registry.free(dynamicSlotOf(second));
  registry.updateTable();

  const reset = allocNoSync(registry, 96);
  assertEquals(reset[TaskIndex.Start], 0);

  const tailA = allocNoSync(registry, 64);
  const tailB = allocNoSync(registry, 64);
  assertEquals(tailA[TaskIndex.Start], align64(96));
  assertEquals(tailB[TaskIndex.Start], align64(96) + 64);

  registry.free(dynamicSlotOf(tailB));
  registry.updateTable();

  const tailReuse = allocNoSync(registry, 64);
  assertEquals(tailReuse[TaskIndex.Start], align64(96) + 64);
});

test("updateTable compacts once four freed holes accumulate", () => {
  const registry = makeRegistry();
  [64, 64, 64, 64, 64, 64].forEach((size) => {
    allocNoSync(registry, size);
  });

  registry.free(0);
  registry.free(1);
  registry.free(2);
  registry.free(3);
  registry.updateTable();

  const task = makeTask();
  task[TaskIndex.PayloadLen] = 64;
  registry.allocTask(task);

  assertEquals(task[TaskIndex.Start], 0);
});

test("updateTable compacts once five freed holes accumulate", () => {
  const registry = makeRegistry();
  [64, 64, 64, 64, 64, 64].forEach((size) => {
    allocNoSync(registry, size);
  });

  registry.free(0);
  registry.free(1);
  registry.free(2);
  registry.free(3);
  registry.free(4);
  registry.updateTable();

  const task = makeTask();
  task[TaskIndex.PayloadLen] = 64;
  registry.allocTask(task);

  assertEquals(task[TaskIndex.Start], 0);
});

test("setSlotLength shrinks slot and exposes gap for next allocation", () => {
  const registry = makeRegistry();

  const first = allocNoSync(registry, 700 * 3);
  const second = allocNoSync(registry, 64);

  assertEquals(second[TaskIndex.Start], align64(700 * 3));
  assertEquals(registry.setSlotLength(dynamicSlotOf(first), 700), true);

  const third = makeTask();
  third[TaskIndex.PayloadLen] = 128;
  registry.allocTask(third);

  assertEquals(third[TaskIndex.Start], align64(700));
});

test("atomic publication preserves toggle-bit allocator invariants", () => {
  const registry = makeRegistry();
  const live = new Map<number, LiveAllocation>();

  for (let i = 0; i < 6; i++) {
    const payloadLen = 1 + (i * 17);
    const task = makeTask();
    task[TaskIndex.PayloadLen] = payloadLen;
    assertEquals(registry.allocTask(task) === -1, false);
    live.set(dynamicSlotOf(task), {
      start: task[TaskIndex.Start],
      size: align64(payloadLen),
    });
  }

  registry.free(1);
  registry.free(3);
  live.delete(1);
  live.delete(3);
  registry.updateTable();
  assertAllocatorInvariants(registry, live);

  const reused = makeTask();
  reused[TaskIndex.PayloadLen] = 8;
  assertEquals(registry.allocTask(reused) === -1, false);
  live.set(dynamicSlotOf(reused), {
    start: reused[TaskIndex.Start],
    size: align64(reused[TaskIndex.PayloadLen]),
  });
  assertAllocatorInvariants(registry, live);
});

test("allocator random overlap stress keeps allocator consistent", () => {
  const registry = makeRegistry();
  const nextRandom = makeRng(0xc0ffee12);
  const live = new Map<number, LiveAllocation>();

  for (let step = 0; step < 6000; step++) {
    const shouldAllocate = live.size === 0 ||
      (live.size < DYNAMIC_PAYLOAD_SLOTS && (nextRandom() & 1) === 0);

    if (shouldAllocate) {
      registry.updateTable();

      const payloadLen = 1 + (nextRandom() % 8192);
      const task = makeTask();
      task[TaskIndex.PayloadLen] = payloadLen;

      const hostBefore = Array.from(registry.hostBits);
      const workerBefore = Array.from(registry.workerBits);

      const allocated = registry.allocTask(task);
      assertEquals(allocated === -1, false);

      let toggledWord = -1;
      let toggled = 0;
      for (let word = 0; word < registry.hostBits.length; word++) {
        const delta = (hostBefore[word]! ^ registry.hostBits[word]!) >>> 0;
        if (delta === 0) continue;
        assertEquals(toggledWord, -1);
        toggledWord = word;
        toggled = delta;
      }
      assertEquals(isSingleBit(toggled), true);
      assertEquals(
        ((hostBefore[toggledWord]! ^ workerBefore[toggledWord]!) & toggled) ===
          0,
        true,
      );

      const slot = dynamicSlotOf(task);
      assertEquals((toggledWord << 5) + 31 - Math.clz32(toggled), slot);
      assertEquals(live.has(slot), false);

      live.set(slot, {
        start: task[TaskIndex.Start],
        size: align64(payloadLen),
      });
    } else {
      const slots = Array.from(live.keys());
      const slot = slots[nextRandom() % slots.length]!;
      registry.free(slot);
      live.delete(slot);
      registry.updateTable();
    }

    assertAllocatorInvariants(registry, live);
  }

  while (live.size > 0) {
    const slot = live.keys().next().value as number;
    registry.free(slot);
    live.delete(slot);
    registry.updateTable();
    assertAllocatorInvariants(registry, live);
  }

  const refilled: ReturnType<typeof makeTask>[] = [];
  for (let i = 0; i < DYNAMIC_PAYLOAD_SLOTS; i++) {
    const task = makeTask();
    task[TaskIndex.PayloadLen] = 64;
    assertEquals(registry.allocTask(task) === -1, false);
    refilled.push(task);
    live.set(dynamicSlotOf(task), {
      start: task[TaskIndex.Start],
      size: align64(task[TaskIndex.PayloadLen]),
    });
  }
  assertAllocatorInvariants(registry, live);

  const overflow = makeTask();
  overflow[TaskIndex.PayloadLen] = 64;
  assertEquals(registry.allocTask(overflow), -1);

  for (const task of refilled) {
    registry.free(dynamicSlotOf(task));
    live.delete(dynamicSlotOf(task));
  }
  registry.updateTable();
  assertAllocatorInvariants(registry, live);
  assertEquals(
    Array.from(registry.hostBits).every(
      (host, word) => host === registry.workerBits[word],
    ),
    true,
  );

  const probe = makeTask();
  probe[TaskIndex.PayloadLen] = 512;
  assertEquals(registry.allocTask(probe) === -1, false);
  assertEquals(probe[TaskIndex.Start], 0);
  registry.free(dynamicSlotOf(probe));
  registry.updateTable();
  assertAllocatorInvariants(registry, live);
});
