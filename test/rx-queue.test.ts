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
  } as any);

  const originalNow = performance.now;
  let nowValue = 1000;
  performance.now = () => nowValue;
  try {
    const slot = makeTask();
    slot[TaskIndex.FunctionID] = 0;
    slot.value = 123;
    setTaskSlotMeta(slot, (950 & TASK_SLOT_META_VALUE_MASK) >>> 0);
    resolved.push(slot);

    assert.equal(queue.enqueueLock(), true);
    assert.equal(queue.serviceBatchImmediate(), 1);
    await Promise.resolve();
  } finally {
    performance.now = originalNow;
  }

  assert.ok(sent);
  assert.equal(sent![TaskIndex.FlagsToHost], TaskFlag.Reject);
  assert.equal((sent!.value as Error).message, "Task timeout");
  assert.equal(queue.getAwaiting(), 0);
});
