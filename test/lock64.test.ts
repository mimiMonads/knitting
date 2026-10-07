import assert from "node:assert/strict";
import test from "./_runner.ts";
import RingQueue from "../src/ipc/tools/ring-queue.ts";
import { createLockControlCarpet } from "../src/memory/byte-carpet.ts";
import {
  getTaskFunctionID,
  getTaskFunctionMeta,
  getTaskSlotMeta,
  HEADER64_BYTE_LENGTH,
  HEADER_BYTE_LENGTH,
  HEADER_SLOT_STRIDE_U32,
  HEADER_TASK_OFFSET_IN_SLOT_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  makeTask,
  setTaskFunctionID,
  setTaskFunctionMeta,
  setTaskSlotMeta,
  STEAL_TICKET_HEAD_SLOT_OFFSET_U32,
  type Task,
  TASK_FUNCTION_ID_MASK,
  TASK_SLOT_META_VALUE_MASK,
  TaskIndex,
} from "../src/memory/lock.ts";
import { RUNTIME } from "../src/common/runtime.ts";
import "../src/memory/payloadCodec.ts";
import { Envelope } from "../src/common/envelope.ts";

const valueTask = (value: unknown, id = 0): Task => {
  const task = makeTask();
  task[TaskIndex.ID] = id;
  task.value = value;
  return task;
};
const pair = (options: Partial<Parameters<typeof lock2>[0]> = {}) => {
  const shared = {
    slots: 64 as const,
    headers: new SharedArrayBuffer(HEADER64_BYTE_LENGTH),
    LockBoundSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
    payload: new SharedArrayBuffer(1 << 20),
  };
  return {
    shared,
    sender: lock2({ ...shared, ...options }),
    receiver: lock2(shared),
  };
};

test("64 slots use the existing sector and both signed word boundaries", () => {
  const { sender, receiver } = pair();
  assert.equal(sender.hostBits.length, 2);
  assert.equal(sender.hostBits.buffer.byteLength, LOCK_SECTOR_BYTE_LENGTH);
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 64; i++) assert(sender.encode(valueTask(i)));
    assert.equal(sender.encode(valueTask("full")), false);
    assert(receiver.decode());
    assert.deepEqual(
      receiver.resolved.toArray().map((t) => t.value),
      Array.from({ length: 64 }, (_, i) => i),
    );
    receiver.resolved.clear();
    assert.deepEqual(
      Array.from(sender.workerBits),
      Array.from(sender.hostBits),
    );
    assert.equal(receiver.decode(), false);
  }
});

test("64-slot sender refreshes one 64-bit shadow only after both halves exhaust", () => {
  const originalLoad = Atomics.load;
  let workerBuffer: ArrayBufferLike | undefined;
  let loads = 0;
  Atomics.load = ((view: Parameters<typeof Atomics.load>[0], index: number) => {
    if (view.buffer === workerBuffer && view.byteOffset === 64) {
      assert(view instanceof BigInt64Array);
      loads++;
    }
    return originalLoad(view, index);
  }) as typeof Atomics.load;
  try {
    const { sender } = pair();
    workerBuffer = sender.workerBits.buffer;
    for (let i = 0; i < 32; i++) assert(sender.encode(valueTask(i)));
    // Retire lane 63 in shared memory while the low half still looks free.
    Atomics.xor(sender.workerBits, 1, 1 << 31);
    for (let i = 32; i < 64; i++) assert(sender.encode(valueTask(i)));
    assert.equal(loads, 0);
    assert.equal(sender.hostBits[0], -1);
    assert.equal(sender.hostBits[1], -1);
    assert(sender.encode(valueTask("reused")));
    assert.equal(loads, 1);
    assert.equal(sender.hostBits[1], 0x7fffffff);
    assert.equal(sender.encode(valueTask("still full")), false);
    assert.equal(loads, 2);
  } finally {
    Atomics.load = originalLoad;
  }
});

test("wide queue preserves every task across half-boundaries and partial reuse", () => {
  const { sender, receiver } = pair();
  let next = 0;
  const seen = new Set<number>();
  let seed = 0x12345678;
  for (let round = 0; round < 500; round++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const size = 1 + ((seed >>> 0) % 80);
    for (let i = 0; i < size; i++) {
      if (!sender.encode(valueTask(next))) break;
      next++;
    }
    receiver.decode();
    while (!receiver.resolved.isEmpty) {
      const value = receiver.resolved.shift()!.value as number;
      assert(!seen.has(value), `duplicate ${value}`);
      seen.add(value);
    }
  }
  assert.equal(seen.size, next);
  for (let i = 0; i < next; i++) assert(seen.has(i));
});

test("wide scans preserve the cyclic lane order for sparse snapshots", () => {
  const { sender, receiver } = pair();
  for (let i = 0; i < 64; i++) assert(sender.encode(valueTask(i)));
  receiver.decode();
  receiver.resolved.clear();
  let cursor = 0;
  let seed = 0x87654321;
  const randomWord = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed | 0;
  };
  for (let round = 0; round < 1000; round++) {
    const bits = [randomWord(), randomWord()];
    const expected: number[] = [];
    // Reference circular walk: visit each lane once below the prior cursor.
    for (let step = 1; step <= 64; step++) {
      const at = (cursor - step) & 63;
      if ((bits[at >>> 5]! & (1 << at)) !== 0) expected.push(at);
    }
    if (expected.length !== 0) cursor = expected.at(-1)!;
    for (let word = 0; word < 2; word++) {
      Atomics.store(
        sender.hostBits,
        word,
        receiver.workerBits[word]! ^ bits[word]!,
      );
    }
    receiver.decode();
    assert.deepEqual(
      receiver.resolved.toArray().map((t) => 63 - (t.value as number)),
      expected,
    );
    receiver.resolved.clear();
    assert.deepEqual(
      Array.from(receiver.workerBits),
      Array.from(sender.hostBits),
    );
  }
});

test("wide pending queues and promise payloads retain their accounting", async () => {
  const { sender, receiver } = pair();
  const list = new RingQueue<Task>();
  for (let i = 0; i < 70; i++) list.push(valueTask(i));
  assert.equal(sender.encodeManyFrom(list), 64);
  assert.equal(list.size, 6);
  receiver.decode();
  receiver.resolved.clear();
  while (!list.isEmpty) sender.enlist(list.shift()!);
  assert(sender.encodeAll());
  receiver.decode();
  assert.deepEqual(receiver.resolved.toArray().map((t) => t.value), [
    64,
    65,
    66,
    67,
    68,
    69,
  ]);
  receiver.resolved.clear();

  let release!: (value: unknown) => void;
  sender.setPromiseHandler((task, rejected, value) => {
    assert.equal(rejected, false);
    task.value = value;
    sender.publish(task);
  });
  const promiseTask = valueTask(new Promise((resolve) => release = resolve));
  assert.equal(sender.publish(promiseTask), false);
  assert.equal(sender.getPendingPromiseCount(), 1);
  release("settled");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sender.getPendingPromiseCount(), 0);
  receiver.decode();
  assert.equal(receiver.resolved.shift()!.value, "settled");
});

test("wide static and dynamic payloads cover every header slot", () => {
  const { sender, receiver } = pair();
  const values = Array.from({ length: 64 }, (_, i) => {
    switch (i % 8) {
      case 0:
        return { index: i, label: "static json" };
      case 1:
        return new Int32Array([i, -i]);
      case 2:
        return new Float64Array([i, -3.5]);
      case 3:
        return new BigInt64Array([BigInt(i), -9n]);
      case 4:
        return new BigUint64Array([BigInt(i), 1n << 63n]);
      case 5:
        return new Uint8Array([i, 127, 255]);
      case 6:
        return [i, 2.5, -3];
      default:
        return `dynamic-${i}:` + "x".repeat(2048);
    }
  });
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 64; i++) assert(sender.encode(valueTask(values[i], i)));
    receiver.decode();
    const tasks = receiver.resolved.toArray().sort((a, b) =>
      a[TaskIndex.ID] - b[TaskIndex.ID]
    );
    assert.deepEqual(tasks.map((t) => t.value), values);
    receiver.resolved.clear();
  }
});

test("wide queue lanes do not collide with function, abort, timeout or payload-region bits", () => {
  const { shared, sender, receiver } = pair();
  const headers = new Uint32Array(shared.headers);
  const timestamps = [0, 31, 32, 63, 64, TASK_SLOT_META_VALUE_MASK];
  const signalMeta = [1, 32, 33, 64, 65, 258, 0xffff];
  for (let round = 0; round < 3; round++) {
    const values = Array.from(
      { length: 64 },
      (_, i) => new Envelope({ round, i }, new Uint8Array(2048).fill(i).buffer),
    );
    for (let i = 0; i < 64; i++) {
      const task = valueTask(values[i], i);
      const functionID = TASK_FUNCTION_ID_MASK - i;
      const meta = signalMeta[i % signalMeta.length]!;
      const timestamp = timestamps[i % timestamps.length]!;
      setTaskFunctionID(task, functionID);
      setTaskFunctionMeta(task, meta);
      setTaskSlotMeta(task, timestamp);
      assert(sender.encode(task));
      const off = (63 - i) * HEADER_SLOT_STRIDE_U32 +
        HEADER_TASK_OFFSET_IN_SLOT_U32;
      const header = headers.subarray(off, off + TaskIndex.Size);
      assert.equal(getTaskFunctionID(header), functionID);
      assert.equal(getTaskFunctionMeta(header), meta);
      assert.equal(getTaskSlotMeta(header), timestamp);
      // All 64 dynamic identities are live: bit 31 of End must distinguish
      // regions 32..63 without stealing a timestamp or abort-id bit.
      const region = (header[TaskIndex.slotBuffer]! & 31) |
        ((header[TaskIndex.End]! >>> 31) << 5);
      assert.equal(region, i);
      assert.equal(
        header[TaskIndex.End]! & 0x7fffffff,
        values[i]!.payload.byteLength,
      );
    }
    assert(receiver.decode());
    const decoded = receiver.resolved.toArray();
    assert.equal(decoded.length, 64);
    for (const task of decoded) {
      const i = task[TaskIndex.ID];
      assert.deepEqual(task.value, values[i]);
      assert.equal(getTaskFunctionID(task), TASK_FUNCTION_ID_MASK - i);
      assert.equal(
        getTaskFunctionMeta(task),
        signalMeta[i % signalMeta.length],
      );
      assert.equal(getTaskSlotMeta(task), timestamps[i % timestamps.length]);
    }
    receiver.resolved.clear();
  }
});

for (const mode of ["plain", "callback", "predicate", "active"] as const) {
  test(`wide resolveHost handles both halves (${mode})`, () => {
    const { sender, receiver } = pair();
    const values: unknown[] = [], resolved: number[] = [];
    const inactive = () => {};
    const queue = Array.from({ length: 64 }, (_, i) => {
      const task = valueTask(null, i);
      task.resolve = (value) => values.push(value);
      if (mode === "active" && (i & 1) !== 0) task.reject = inactive;
      return task;
    });
    const drain = receiver.resolveHost({
      queue,
      onResolved: mode === "plain"
        ? undefined
        : (t) => resolved.push(t[TaskIndex.ID]),
      shouldSettle: mode === "predicate"
        ? (t) => (t[TaskIndex.ID] & 1) === 0
        : undefined,
      activeRejectPlaceholder: mode === "active" ? inactive : undefined,
    });
    for (let round = 0; round < 3; round++) {
      values.length = resolved.length = 0;
      for (let i = 0; i < 64; i++) assert(sender.encode(valueTask(i, i)));
      assert.equal(drain(), 64);
      const expected = Array.from({ length: 64 }, (_, i) => i)
        .filter((i) =>
          mode !== "predicate" && mode !== "active" || (i & 1) === 0
        );
      assert.deepEqual(values, expected);
      if (mode !== "plain") assert.deepEqual(resolved, expected);
      assert.deepEqual(
        Array.from(sender.hostBits),
        Array.from(sender.workerBits),
      );
    }
  });
}

test("wide snapshots retire decoded slots when decoding throws", () => {
  const { shared, sender, receiver } = pair();
  for (let i = 0; i < 64; i++) assert(sender.encode(valueTask(i)));
  let decoded = 0;
  const failing = lock2({
    ...shared,
    recycleList: {
      shiftNoClear: () => {
        if (++decoded > 32) throw new Error("decode blew up");
        return undefined;
      },
    } as unknown as RingQueue<Task>,
  });
  assert.throws(() => failing.decode(), /decode blew up/);
  assert.equal(failing.resolved.size, 32);
  assert.equal(failing.workerBits[1], failing.hostBits[1]);
  assert.equal(failing.workerBits[0], 0);
});

for (const claim of ["ticket", "dekker"] as const) {
  for (const lanes of claim === "ticket" ? [1, 8, 64] : [2, 8, 16]) {
    test(`64-slot ${claim} stealing retires both halves exactly once, lanes=${lanes}`, () => {
      const { shared } = pair();
      const producer = lock2({
        ...shared,
        consumers: 3,
        regionLanes: lanes,
        stealClaim: claim,
      });
      const consumers = Array.from({ length: 3 }, (_, consumerId) =>
        lock2({
          ...shared,
          consumers: 3,
          consumerId,
          regionLanes: lanes,
          stealClaim: claim,
        }));
      const seen = new Set<number>();
      for (let round = 0; round < 20; round++) {
        for (let i = 0; i < 64; i++) {
          assert(producer.encode(valueTask(round * 64 + i)));
        }
        assert.equal(producer.encode(valueTask("full")), false);
        let guard = 0;
        while (seen.size < (round + 1) * 64) {
          assert(++guard < 1000, "steal made no progress");
          const consumer = consumers[guard % 3]!;
          consumer.decode();
          while (!consumer.resolved.isEmpty) {
            const value = consumer.resolved.shift()!.value as number;
            assert(!seen.has(value), `duplicate ${value}`);
            seen.add(value);
          }
        }
        assert.deepEqual(
          Array.from(producer.hostBits),
          Array.from(producer.workerBits),
        );
      }
      assert.equal(seen.size, 1280);
    });
  }
}

test("64-slot tickets preserve order across the wrapping publication tail", () => {
  const { shared } = pair();
  const producer = lock2({
    ...shared,
    consumers: 2,
    regionLanes: 64,
    stealClaim: "ticket",
  });
  const consumer = lock2({
    ...shared,
    consumers: 2,
    consumerId: 0,
    regionLanes: 64,
    stealClaim: "ticket",
  });
  const head = new BigInt64Array(shared.headers);
  // Start the consumer near tail wrap, then populate the corresponding ring
  // cells and tail directly; the normal sender still supplies all lane headers.
  for (let i = 0; i < 64; i++) assert(producer.encode(valueTask(i)));
  const words = new Int32Array(shared.headers);
  const start = 0xffffffe0;
  Atomics.store(head, STEAL_TICKET_HEAD_SLOT_OFFSET_U32 >>> 1, BigInt(start));
  for (let i = 0; i < 64; i++) {
    words[
      ((start + i) & 63) * HEADER_SLOT_STRIDE_U32 +
      HEADER_TASK_OFFSET_IN_SLOT_U32 + 8
    ] = 63 - i;
  }
  Atomics.store(
    words,
    HEADER_SLOT_STRIDE_U32 + STEAL_TICKET_HEAD_SLOT_OFFSET_U32,
    (start + 64) | 0,
  );
  assert(consumer.decode());
  assert.deepEqual(
    consumer.resolved.toArray().map((t) => t.value),
    Array.from({ length: 64 }, (_, i) => i),
  );
});

test("wide ticket batches flush both halves when a queue operation throws", () => {
  const { shared } = pair();
  const producer = lock2({
    ...shared,
    consumers: 2,
    regionLanes: 64,
    stealClaim: "ticket",
  });
  const consumer = lock2({
    ...shared,
    consumers: 2,
    consumerId: 0,
    regionLanes: 64,
    stealClaim: "ticket",
  });
  let index = 0;
  const list = {
    shiftNoClear: () => {
      if (index === 33) throw new Error("queue failed");
      return valueTask(index++);
    },
  } as unknown as RingQueue<Task>;
  assert.throws(() => producer.encodeManyFrom(list), /queue failed/);
  assert(consumer.decode());
  assert.deepEqual(
    consumer.resolved.toArray().map((t) => t.value),
    Array.from({ length: 33 }, (_, i) => i),
  );
  assert.deepEqual(
    Array.from(producer.workerBits),
    Array.from(producer.hostBits),
  );
});

test("upper-half publications participate in the native notifier arm", () => {
  let rings = 0;
  const { sender, receiver } = pair({
    notifyOnHostPublish: true,
    notifyHostPublish: () => rings++,
  });
  assert(receiver.armHostNotifier());
  assert(sender.encode(valueTask("upper half")));
  assert.equal(sender.hostBits[0], 0);
  assert.equal(rings, 1);
  assert.equal(receiver.armHostNotifier(), false);
  receiver.decode();
  assert(receiver.armHostNotifier());
  assert(sender.encode(valueTask("next upper lane")));
  assert.equal(rings, 2);
});

test("upper-half publications wake a 64-bit async waiter", {
  skip: RUNTIME === "deno",
}, async () => {
  const { sender, receiver } = pair({ notifyOnHostPublish: true });
  const wait = receiver.waitForHostChange(500);
  assert(wait?.async);
  setTimeout(() => sender.encode(valueTask("wake")), 10);
  assert.equal(await wait.value, "ok");
  receiver.decode();
  assert(sender.encode(valueTask("raced the arm")));
  const raced = receiver.waitForHostChange(500);
  assert.equal(raced?.async, false);
  assert.equal(raced?.value, "not-equal");
});

test("wide locks validate width and header capacity, including interleaved regions", () => {
  assert.throws(() => lock2({ slots: 48 as never }), /32 or 64/);
  assert.throws(
    () =>
      lock2({ slots: 64, headers: new SharedArrayBuffer(HEADER_BYTE_LENGTH) }),
    /64 slots/,
  );
  const carpet = createLockControlCarpet({
    signalBytes: 0,
    abortBytes: 0,
    slotCount: 64,
    lockSectorBytes: LOCK_SECTOR_BYTE_LENGTH,
    headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
    headerLayout: "interleaved",
  });
  for (const buffers of [carpet.lock, carpet.returnLock]) {
    const lock = lock2({
      slots: 64,
      headers: buffers.headers,
      headerSlotStrideU32: buffers.headerSlotStrideU32,
      LockBoundSector: buffers.lockSector,
    });
    for (let i = 0; i < 64; i++) assert(lock.encode(valueTask(i)));
    assert(lock.decode());
    assert.equal(lock.resolved.size, 64);
  }
});
