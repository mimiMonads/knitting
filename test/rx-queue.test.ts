import assert from "node:assert/strict";
import test from "./_runner.ts";
import RingQueue from "../src/ipc/tools/ring-queue.ts";
import {
  makeTask,
  setTaskSlotMeta,
  type Task,
  TASK_SLOT_META_VALUE_MASK,
  TaskFlag,
  TaskIndex,
} from "../src/memory/lock.ts";
import { createWorkerRxQueue } from "../src/worker/rx-queue.ts";
import { withResolvers } from "../src/common/with-resolvers.ts";

test("wide return finalizers wait for upper-half acknowledgements", () => {
  const resolved = new RingQueue<Task>();
  const recyclecList = new RingQueue<Task>();
  const hostBits = new Int32Array(new SharedArrayBuffer(8));
  const workerBits = new Int32Array(new SharedArrayBuffer(8));
  let released = 0;
  const queue = createWorkerRxQueue({
    listOfFunctions: [{ run: (value: unknown) => value }],
    lock: { decode: () => true, resolved, recyclecList },
    returnLock: {
      hostBits, workerBits,
      encode: (slot: Task) => {
        slot.finalize = () => released++;
        Atomics.store(hostBits, 1, 1 << 31);
        return true;
      },
    },
  } as any);
  const slot = makeTask();
  slot.value = 42;
  resolved.push(slot);
  assert(queue.enqueueLock());
  assert.equal(queue.serviceBatchImmediate(), 1);
  queue.drainReturnReleases();
  assert.equal(released, 0);
  Atomics.store(workerBits, 1, hostBits[1]!);
  queue.drainReturnReleases();
  assert.equal(released, 1);
});

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

test("worker abort check passes aborted toolkit into task function", () => {
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
      run: (value: unknown, tbh?: { hasAborted: () => boolean }) => {
        called++;
        return {
          value,
          aborted: tbh?.hasAborted(),
        };
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
  assert.equal(sent![TaskIndex.FlagsToHost], 0);
  assert.deepEqual(sent!.value, {
    value: 123,
    aborted: true,
  });
  assert.equal(called, 1);
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
  assert.deepEqual(seenSignals, [0]);
});

test("worker queue drops original args once async work has been invoked", () => {
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

  const pending = withResolvers<number>();
  const returnLock = {
    encode: () => true,
  } as unknown as {
    encode: (task: Task) => boolean;
  };

  const queue = createWorkerRxQueue({
    listOfFunctions: [{
      run: () => pending.promise,
    }] as unknown as Array<{ run: (args: unknown) => unknown }>,
    lock: lock as any,
    returnLock: returnLock as any,
  } as any);

  const slot = makeTask();
  slot[TaskIndex.FunctionID] = 0;
  slot.value = { big: "x".repeat(4096) };
  resolved.push(slot);

  assert.equal(queue.enqueueLock(), true);
  assert.equal(queue.serviceBatchImmediate(), 1);
  assert.equal(slot.value, null);

  pending.resolve(1);
});

const adaptiveQueue = (
  options: { stealing: boolean; singleClaimAboveMs?: number },
) => {
  const resolved = new RingQueue<Task>();
  const recyclecList = new RingQueue<Task>();
  const limits: number[] = [];
  let clock = 0;
  let taskMs: number | number[] = 0;
  let clockReads = 0;
  const lock = {
    decode: () => resolved.size !== 0,
    resolved,
    recyclecList,
    setStealClaimLimit: (limit: number) => {
      limits.push(limit);
      return true;
    },
  };
  const queue = createWorkerRxQueue({
    listOfFunctions: [{
      run: (value: unknown) => {
        clock += Array.isArray(taskMs) ? taskMs[value as number]! : taskMs;
        return value;
      },
    }],
    lock,
    returnLock: { encode: () => true },
    now: () => {
      clockReads++;
      return clock;
    },
    ...options,
  } as any);
  const runBatch = (count: number, ms: number | number[]) => {
    taskMs = ms;
    for (let i = 0; i < count; i++) {
      const slot = makeTask();
      slot[TaskIndex.FunctionID] = 0;
      slot.value = i;
      resolved.push(slot);
    }
    assert.equal(queue.enqueueLock(), true);
    assert.equal(queue.serviceBatchImmediate(), count);
  };
  return { queue, limits, runBatch, getClockReads: () => clockReads };
};

test("stealing worker claims singly while tasks are expensive, then batches again", () => {
  const { queue, limits, runBatch } = adaptiveQueue({
    stealing: true,
    singleClaimAboveMs: 0.02,
  });

  runBatch(4, 0.001);
  assert.deepEqual(limits, [], "1 µs tasks keep the configured batch");

  // One expensive task in a batch of four still averages 2.5 ms.
  runBatch(4, [0.001, 10, 0.001, 0.001]);
  assert.deepEqual(limits, [1]);
  assert.equal(queue.isClaimingSingle(), true);

  // The cost peak decays per batch, so cheap batches right after it stay single.
  for (let i = 0; i < 10; i++) runBatch(1, 0.001);
  assert.deepEqual(limits, [1]);

  for (let i = 0; i < 200 && limits.length === 1; i++) runBatch(1, 0.001);
  assert.deepEqual(limits, [1, Infinity]);
  assert.equal(queue.isClaimingSingle(), false);
});

test("private lanes and a zero threshold never change the claim width", () => {
  for (
    const options of [
      { stealing: false, singleClaimAboveMs: 0.02 },
      { stealing: true, singleClaimAboveMs: 0 },
      { stealing: true },
    ]
  ) {
    const { limits, runBatch, getClockReads } = adaptiveQueue(options);
    runBatch(4, 5);
    runBatch(4, 0.001);
    assert.deepEqual(limits, [], JSON.stringify(options));
    assert.equal(getClockReads(), 0, "disabled adaptation never reads the clock");
  }
});
