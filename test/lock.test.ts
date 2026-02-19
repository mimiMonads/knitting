import assert from "node:assert/strict";
import test from "node:test";
const assertEquals: (actual: unknown, expected: unknown) => void =
  (actual, expected) => {
    assert.deepStrictEqual(actual, expected);
  };
import RingQueue from "../src/ipc/tools/RingQueue.ts";
import {
  HEADER_BYTE_LENGTH,
  HEADER_SLOT_STRIDE_U32,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  lock2,
  makeTask,
  PayloadSignal,
  TaskIndex,
} from "../src/memory/lock.ts";
import { decodePayload } from "../src/memory/payloadCodec.ts";

const makeLock = () => {
  const toBeSent = new RingQueue<ReturnType<typeof makeTask>>();
  const lock = lock2({ toSentList: toBeSent });
  return { lock, toBeSent };
};

const makeValueTask = (value: unknown) => {
  const task = makeTask();
  task.value = value;
  return task;
};

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

test("encode/decode roundtrip values", () => {
  const { lock } = makeLock();
  const values = [123, -45.5, true, false, 9n, Infinity, -Infinity, NaN, undefined];

  for (const value of values) {
    assert(lock.encode(makeValueTask(value)));
  }

  assert(lock.decode());
  const decoded = lock.resolved.toArray().map((task) => task.value);

  assertEquals(decoded.length, values.length);
  for (let i = 0; i < values.length; i++) {
    const expected = values[i];
    const actual = decoded[i];
    if (typeof expected === "number" && Number.isNaN(expected)) {
      assert(typeof actual === "number" && Number.isNaN(actual));
      continue;
    }
    assertEquals(actual, expected);
  }
});

test("encode/decode roundtrip string", () => {
  const { lock } = makeLock();
  const value = "hello from lock";

  assert(lock.encode(makeValueTask(value)));
  assert(lock.decode());

  const decoded = lock.resolved.toArray()
  .filter((task) =>  typeof task.value === "string") ;
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].value, value);
});

test("decode is no-op with no new slots", () => {
  const { lock } = makeLock();
  assertEquals(lock.decode(), false);
});

test("encode stops when full", () => {
  const { lock } = makeLock();

  for (let i = 0; i < LockBound.slots; i++) {
    assert(lock.encode(makeValueTask(i)));
  }

  assertEquals(lock.encode(makeValueTask(999)), false);
  assertEquals(lock.hostBits[0] >>> 0, 0xFFFFFFFF);
});

test("encodeAll leaves remaining task when full", () => {
  const { lock, toBeSent } = makeLock();
  const tasks = Array.from(
    { length: LockBound.slots + 1 },
    (_, i) => makeValueTask(i),
  );

  for (const task of tasks) lock.enlist(task);

  assertEquals(lock.encodeAll(), false);
  assertEquals(toBeSent.size, 1);
  assertEquals(toBeSent.peek(), tasks[tasks.length - 1]);
});

test("decode syncs worker bits", () => {
  const { lock } = makeLock();

  lock.encode(makeValueTask(1));
  lock.encode(makeValueTask(2));

  assert(lock.decode());
  assertEquals(lock.workerBits[0], lock.hostBits[0]);
  assertEquals(lock.decode(), false);
});

test("resolveHost decodes into queue and acks worker bits", () => {
  const lockSector = new SharedArrayBuffer(
    LOCK_SECTOR_BYTE_LENGTH,
  );
  const headers = new SharedArrayBuffer(HEADER_BYTE_LENGTH);
  const payload = new SharedArrayBuffer(
    64 * 1024 * 1024,
    { maxByteLength: 64 * 1024 * 1024 },
  );
  const lock = lock2({
    headers,
    LockBoundSector: lockSector,
    payload,
  });
  const headersBuffer = new Uint32Array(headers);
  const decode = decodePayload({ sab: payload, headersBuffer });

  const results: unknown[] = [];
  const queue = Array.from({ length: 2 }, (_, i) => {
    const task = makeTask();
    task[TaskIndex.ID] = i;
    task.resolve = (value) => {
      results[i] = value;
    };
    task.reject = (reason) => {
      results[i] = reason;
    };
    return task;
  });

  const responses = [123, "ok"];
  for (let i = 0; i < responses.length; i++) {
    const task = makeTask();
    task[TaskIndex.ID] = i;
    task.value = responses[i];
    lock.encode(task);
  }

  const resolveHost = lock.resolveHost({ queue, });

  assert(resolveHost());
  assertEquals(results, responses);
  assertEquals(lock.workerBits[0], lock.hostBits[0]);
  assertEquals(resolveHost(), 0);
});

test("xor bit protocol random stress keeps slot toggles consistent", () => {
  const { lock } = makeLock();
  const nextRandom = makeRng(0x1badf00d);
  const decoded = new Set<number>();
  let nextValue = 1;
  let inFlight = 0;

  const drainResolved = () => {
    let count = 0;
    while (true) {
      const task = lock.resolved.shift();
      if (!task) break;
      assertEquals(typeof task.value, "number");
      const value = task.value as number;
      assertEquals(decoded.has(value), false);
      decoded.add(value);
      count++;
    }
    return count;
  };

  for (let step = 0; step < 5000; step++) {
    const shouldEncode = inFlight === 0 ||
      ((nextRandom() & 3) !== 0 && inFlight < LockBound.slots);

    if (shouldEncode) {
      const task = makeValueTask(nextValue++);
      const hostBefore = lock.hostBits[0] | 0;
      const workerBefore = lock.workerBits[0] | 0;
      const pendingBefore = (hostBefore ^ workerBefore) >>> 0;

      const encoded = lock.encode(task);
      if (!encoded) {
        assertEquals(pendingBefore, 0xFFFFFFFF);
        continue;
      }

      const hostAfter = lock.hostBits[0] | 0;
      const toggled = (hostBefore ^ hostAfter) >>> 0;
      assertEquals(isSingleBit(toggled), true);
      assertEquals((pendingBefore & toggled) === 0, true);
      inFlight++;
      continue;
    }

    const pendingBefore = (lock.hostBits[0] ^ lock.workerBits[0]) >>> 0;
    const changed = lock.decode();
    if (pendingBefore === 0) {
      assertEquals(changed, false);
      continue;
    }

    assertEquals(changed, true);
    assertEquals(lock.workerBits[0], lock.hostBits[0]);
    const drained = drainResolved();
    assertEquals(drained, popcount32(pendingBefore));
    inFlight -= drained;
  }

  while (lock.decode()) {
    inFlight -= drainResolved();
  }
  assertEquals(drainResolved(), 0);
  assertEquals(inFlight, 0);
  assertEquals(lock.workerBits[0], lock.hostBits[0]);
});

test("xor decode finally path preserves consistency on mid-stream errors", () => {
  const nextRandom = makeRng(0x0ddc0ffe);
  const decoded = new Set<number>();
  let nextValue = 1;

  const slotOffset = (at: number) =>
    (at * HEADER_SLOT_STRIDE_U32) + LockBound.header;

  for (let round = 0; round < 128; round++) {
    const lockSector = new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);
    const headers = new SharedArrayBuffer(HEADER_BYTE_LENGTH);
    const payload = new SharedArrayBuffer(4096);
    const headersBuffer = new Uint32Array(headers);
    const lock = lock2({
      headers,
      LockBoundSector: lockSector,
      payload,
    });

    const drainResolved = () => {
      let count = 0;
      while (true) {
        const task = lock.resolved.shift();
        if (!task) break;
        assertEquals(typeof task.value, "number");
        const value = task.value as number;
        assertEquals(decoded.has(value), false);
        decoded.add(value);
        count++;
      }
      return count;
    };

    const batch = 3 + (nextRandom() % 8);
    const slots: number[] = [];

    for (let i = 0; i < batch; i++) {
      const hostBefore = lock.hostBits[0] | 0;
      const workerBefore = lock.workerBits[0] | 0;
      const pendingBefore = (hostBefore ^ workerBefore) >>> 0;
      const task = makeValueTask(nextValue++);
      assertEquals(lock.encode(task), true);

      const hostAfter = lock.hostBits[0] | 0;
      const toggled = (hostBefore ^ hostAfter) >>> 0;
      assertEquals(isSingleBit(toggled), true);
      assertEquals((pendingBefore & toggled) === 0, true);
      slots.push(31 - Math.clz32(toggled));
    }

    slots.sort((a, b) => b - a);
    const failAt = 1 + (nextRandom() % (slots.length - 1));
    const failSlot = slots[failAt];
    const off = slotOffset(failSlot);
    const originalType = headersBuffer[off + TaskIndex.Type];
    headersBuffer[off + TaskIndex.Type] = PayloadSignal.UNREACHABLE;

    const workerBeforeThrow = lock.workerBits[0] | 0;
    assert.throws(
      () => lock.decode(),
      (err: unknown) => String(err).includes("UREACHABLE"),
    );

    let expectedAckDelta = 0;
    for (let i = 0; i < failAt; i++) {
      expectedAckDelta |= 1 << slots[i];
    }
    const ackDelta = (workerBeforeThrow ^ (lock.workerBits[0] | 0)) >>> 0;
    assertEquals(ackDelta, expectedAckDelta >>> 0);
    assertEquals(drainResolved(), failAt);

    headersBuffer[off + TaskIndex.Type] = originalType;
    assertEquals(lock.decode(), true);
    assertEquals(drainResolved(), batch - failAt);
    assertEquals(lock.workerBits[0], lock.hostBits[0]);

    while (lock.decode()) {
      drainResolved();
    }
    assertEquals(lock.workerBits[0], lock.hostBits[0]);
  }
});
