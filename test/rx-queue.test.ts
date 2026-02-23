import assert from "node:assert/strict";
import test from "node:test";
import RingQueue from "../src/ipc/tools/RingQueue.ts";
import { TaskFlag, TaskIndex, TASK_SLOT_META_VALUE_MASK, makeTask, setTaskSlotMeta, type Task } from "../src/memory/lock.ts";
import { createWorkerRxQueue } from "../src/worker/rx-queue.ts";

test("worker queue async settle handles encode backpressure without unhandledRejection", async () => {
  const resolved = new RingQueue<Task>();
  const recyclecList = new RingQueue<Task>();
  const lock = {
    decode: () => true,
    resolved,
    recyclecList,
  } as unknown as {
    decode: () => boolean;
    resolved: RingQueue<Task>;
    recyclecList: RingQueue<Task>;
  };

  let encodeCalls = 0;
  const returnLock = {
    encode: () => {
      encodeCalls++;
      return encodeCalls > 1;
    },
  } as unknown as {
    encode: (task: Task) => boolean;
  };

  const queue = createWorkerRxQueue({
    listOfFunctions: [{
      run: async (value: unknown) => value,
    }] as unknown as Array<{ run: (args: unknown) => unknown }>,
    lock: lock as any,
    returnLock: returnLock as any,
  } as any);

  const slot = makeTask();
  slot[TaskIndex.FunctionID] = 0;
  slot.value = 123;
  resolved.push(slot);

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    assert.equal(queue.enqueueLock(), true);
    assert.equal(queue.serviceBatchImmediate(), 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.equal(encodeCalls, 1);
  assert.equal(queue.writeBatch(1), 1);
  assert.equal(encodeCalls, 2);
  assert.equal(recyclecList.size, 1);
  assert.equal(queue.getAwaiting(), 0);
  assert.equal(unhandled.length, 0);
});

test("worker timeout subtracts queue wait using enqueue timestamp", async () => {
  const resolved = new RingQueue<Task>();
  const recyclecList = new RingQueue<Task>();
  const lock = {
    decode: () => true,
    resolved,
    recyclecList,
  } as unknown as {
    decode: () => boolean;
    resolved: RingQueue<Task>;
    recyclecList: RingQueue<Task>;
  };

  let sent: Task | undefined;
  const returnLock = {
    encode: (task: Task) => {
      sent = task;
      return true;
    },
  } as unknown as {
    encode: (task: Task) => boolean;
  };
  let nowValue = 1000;

  const queue = createWorkerRxQueue({
    listOfFunctions: [{
      run: async (value: unknown) => value,
      timeout: {
        ms: 10,
        kind: 0,
        value: new Error("Task timeout"),
      },
    }] as unknown as Array<{ run: (args: unknown) => unknown }>,
    lock: lock as any,
    returnLock: returnLock as any,
    now: () => nowValue,
  } as any);
  const slot = makeTask();
  slot[TaskIndex.FunctionID] = 0;
  slot.value = 123;
  setTaskSlotMeta(slot, (950 & TASK_SLOT_META_VALUE_MASK) >>> 0);
  resolved.push(slot);

  assert.equal(queue.enqueueLock(), true);
  assert.equal(queue.serviceBatchImmediate(), 1);
  await Promise.resolve();

  assert.ok(sent);
  assert.equal(sent![TaskIndex.FlagsToHost], TaskFlag.Reject);
  assert.equal((sent!.value as Error).message, "Task timeout");
  assert.equal(queue.getAwaiting(), 0);
});

test("worker abort check rejects before invoking task function", () => {
  const resolved = new RingQueue<Task>();
  const recyclecList = new RingQueue<Task>();
  const lock = {
    decode: () => true,
    resolved,
    recyclecList,
  } as unknown as {
    decode: () => boolean;
    resolved: RingQueue<Task>;
    recyclecList: RingQueue<Task>;
  };

  let sent: Task | undefined;
  const returnLock = {
    encode: (task: Task) => {
      sent = task;
      return true;
    },
  } as unknown as {
    encode: (task: Task) => boolean;
  };

  let called = 0;
  const queue = createWorkerRxQueue({
    listOfFunctions: [{
      run: (value: unknown) => {
        called++;
        return value;
      },
    }] as unknown as Array<{ run: (args: unknown) => unknown }>,
    lock: lock as any,
    returnLock: returnLock as any,
    hasAborted: (signal: number) => signal === 0,
  } as any);

  const slot = makeTask();
  // function index 0 + encoded signal meta 1 (signal id 0).
  slot[TaskIndex.FunctionID] = (1 << 16) | 0;
  slot.value = 123;
  resolved.push(slot);

  assert.equal(queue.enqueueLock(), true);
  assert.equal(queue.serviceBatchImmediate(), 1);

  assert.ok(sent);
  assert.equal(sent![TaskIndex.FlagsToHost], TaskFlag.Reject);
  assert.equal((sent!.value as Error).message, "Task aborted");
  assert.equal(called, 0);
});

test("worker abort toolkit exposes shorthand hasAborted accessor", () => {
  const resolved = new RingQueue<Task>();
  const recyclecList = new RingQueue<Task>();
  const lock = {
    decode: () => true,
    resolved,
    recyclecList,
  } as unknown as {
    decode: () => boolean;
    resolved: RingQueue<Task>;
    recyclecList: RingQueue<Task>;
  };

  let sent: Task | undefined;
  const returnLock = {
    encode: (task: Task) => {
      sent = task;
      return true;
    },
  } as unknown as {
    encode: (task: Task) => boolean;
  };

  const seenSignals: number[] = [];
  const queue = createWorkerRxQueue({
    listOfFunctions: [{
      run: (value: unknown, tbh?: {
        hasAborted: () => boolean;
      }) => ({
        value,
        short: tbh?.hasAborted(),
      }),
    }] as unknown as Array<{ run: (args: unknown) => unknown }>,
    lock: lock as any,
    returnLock: returnLock as any,
    hasAborted: (signal: number) => {
      seenSignals.push(signal);
      return false;
    },
  } as any);

  const slot = makeTask();
  slot[TaskIndex.FunctionID] = (1 << 16) | 0;
  slot.value = 123;
  resolved.push(slot);

  assert.equal(queue.enqueueLock(), true);
  assert.equal(queue.serviceBatchImmediate(), 1);

  assert.ok(sent);
  assert.deepEqual(sent!.value, {
    value: 123,
    short: false,
  });
  assert.deepEqual(seenSignals, [0, 0]);
});
