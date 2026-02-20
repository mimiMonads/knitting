import assert from "node:assert/strict";
import test from "node:test";
import RingQueue from "../src/ipc/tools/RingQueue.ts";
import { TaskIndex, makeTask, type Task } from "../src/memory/lock.ts";
import { createWorkerRxQueue } from "../src/worker/rx-queue.ts";

test("worker queue async settle does not leak unhandledRejection when encode throws", async () => {
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
      throw new Error("encode failed");
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

  assert.equal(encodeCalls > 0, true);
  assert.equal(queue.getAwaiting(), 0);
  assert.equal(unhandled.length, 0);
});
