import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  getTaskSlotMeta,
  HEADER_BYTE_LENGTH,
  type Lock2,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  makeTask,
  PAYLOAD_LOCK_SECTOR_BYTE_LENGTH,
  type Task,
  TASK_SLOT_META_VALUE_MASK,
  TaskIndex,
} from "../src/memory/lock.ts";
import { createHostTxQueue } from "../src/runtime/tx-queue.ts";

const makeQueue = () => {
  const seen: number[] = [];
  let nowValue = 0;
  const lock = {
    publish: (task: Task) => {
      seen.push(getTaskSlotMeta(task));
      return true;
    },
    flushPending: () => false,
    hasPendingFrames: () => false,
    getPendingFrameCount: () => 0,
    getPendingPromiseCount: () => 0,
    resetPendingState: () => {},
  } as unknown as Lock2;

  const returnLock = {
    resolveHost: () => () => 0,
  } as unknown as Lock2;

  return {
    seen,
    setNow: (value: number) => {
      nowValue = value;
    },
    tx: createHostTxQueue({
      lock,
      returnLock,
      max: 1,
      now: () => nowValue,
    }),
  };
};

test("one-lane queue preserves the direct return resolver fast path", () => {
  const lock = {
    publish: () => true,
    flushPending: () => false,
    hasPendingFrames: () => false,
    getPendingFrameCount: () => 0,
    getPendingPromiseCount: () => 0,
    resetPendingState: () => {},
  } as unknown as Lock2;
  const resolveReturn = () => 0;
  const returnLock = {
    resolveHost: () => resolveReturn,
  } as unknown as Lock2;

  const tx = createHostTxQueue({ lock, returnLock });

  assert.equal(tx.completeFrame, resolveReturn);
});

test("tx enqueue encodes timeout into slotBuffer upper bits", () => {
  const { seen, setNow, tx } = makeQueue();
  const callWithoutTimeout = tx.enqueue(0);
  void callWithoutTimeout("a");

  setNow(128);
  const callWithZeroTimeout = tx.enqueue(0, 0);
  void callWithZeroTimeout("b");

  setNow(96_001);
  const callWithObject = tx.enqueue(0, { time: 5, maybe: true });
  void callWithObject("c");

  assert.equal(seen[0], 0);
  assert.equal(seen[1], 128 & TASK_SLOT_META_VALUE_MASK);
  assert.equal(seen[2], 96_001 & TASK_SLOT_META_VALUE_MASK);
});

test("flushToWorker moves a backlogged task into deferred state", () => {
  let pendingFrames = 0;
  let pendingPromises = 0;
  const lock = {
    publish: () => {
      pendingFrames = 1;
      return false;
    },
    flushPending: () => {
      pendingFrames = 0;
      pendingPromises = 1;
      return false;
    },
    hasPendingFrames: () => pendingFrames !== 0,
    getPendingFrameCount: () => pendingFrames,
    getPendingPromiseCount: () => pendingPromises,
    resetPendingState: () => {
      pendingFrames = 0;
      pendingPromises = 0;
    },
  } as unknown as Lock2;

  const returnLock = {
    resolveHost: () => () => 0,
  } as unknown as Lock2;

  const tx = createHostTxQueue({
    lock,
    returnLock,
    max: 1,
  });

  const call = tx.enqueue(0);
  void call(Promise.resolve("later"));

  assert.equal(tx.hasPendingFrames(), true);
  assert.equal(tx.txIdle(), false);

  assert.equal(tx.flushToWorker(), false);
  assert.equal(tx.hasPendingFrames(), false);
  assert.equal(tx.txIdle(), true);
});

test("rejectAll ignores late deferred promise settlement for invalidated slots", () => {
  let publishCount = 0;
  let resetCalls = 0;
  let capturedTask: Task | undefined;
  const lock = {
    publish: (task: Task) => {
      publishCount++;
      capturedTask = task;
      return false;
    },
    flushPending: () => false,
    hasPendingFrames: () => false,
    getPendingFrameCount: () => 0,
    getPendingPromiseCount: () => 1,
    resetPendingState: () => {
      resetCalls++;
    },
  } as unknown as Lock2;

  const returnLock = {
    resolveHost: () => () => 0,
  } as unknown as Lock2;

  const tx = createHostTxQueue({
    lock,
    returnLock,
    max: 1,
  });

  const call = tx.enqueue(0);
  const pending = call(Promise.resolve("later"));
  void pending.catch(() => {});

  assert.equal(publishCount, 1);
  tx.rejectAll("closed");
  assert.equal(resetCalls, 1);

  assert.equal(
    tx.settlePromisePayload(capturedTask!, false, "late"),
    false,
  );
  assert.equal(publishCount, 1);
});

test("late return frames are acked without settling inactive slots", async () => {
  const requestLock = {
    publish: () => true,
    flushPending: () => false,
    hasPendingFrames: () => false,
    getPendingFrameCount: () => 0,
    getPendingPromiseCount: () => 0,
    resetPendingState: () => {},
  } as unknown as Lock2;

  const lockSector = new SharedArrayBuffer(
    LOCK_SECTOR_BYTE_LENGTH,
  );
  const headers = new SharedArrayBuffer(HEADER_BYTE_LENGTH);
  const payloadSector = new SharedArrayBuffer(
    PAYLOAD_LOCK_SECTOR_BYTE_LENGTH,
  );
  const payload = new SharedArrayBuffer(1024 * 64);

  const returnProducer = lock2({
    headers,
    LockBoundSector: lockSector,
    payload,
    payloadSector,
  });
  const returnConsumer = lock2({
    headers,
    LockBoundSector: lockSector,
    payload,
    payloadSector,
  });

  const tx = createHostTxQueue({
    lock: requestLock,
    returnLock: returnConsumer,
    max: 1,
  });

  const firstCall = tx.enqueue(0);
  const firstPromise = firstCall("first");

  const firstResponse = makeTask();
  firstResponse[TaskIndex.ID] = 0;
  firstResponse.value = "first-result";
  assert.equal(returnProducer.encode(firstResponse), true);
  assert.equal(tx.completeFrame(), 1);
  assert.equal(await firstPromise, "first-result");

  const lateResponse = makeTask();
  lateResponse[TaskIndex.ID] = 0;
  lateResponse.value = "late-result";
  assert.equal(returnProducer.encode(lateResponse), true);
  assert.equal(tx.completeFrame(), 1);

  const secondCall = tx.enqueue(0);
  const secondPromise = secondCall("second");

  const secondResponse = makeTask();
  secondResponse[TaskIndex.ID] = 0;
  secondResponse.value = "second-result";
  assert.equal(returnProducer.encode(secondResponse), true);
  assert.equal(tx.completeFrame(), 1);
  assert.equal(await secondPromise, "second-result");
});

test("tx queue clears slot value after a response settles", async () => {
  const requestLock = {
    publish: () => true,
    flushPending: () => false,
    hasPendingFrames: () => false,
    getPendingFrameCount: () => 0,
    getPendingPromiseCount: () => 0,
    resetPendingState: () => {},
  } as unknown as Lock2;

  let capturedQueue: Task[] | undefined;
  const returnLock = {
    resolveHost: ({ queue, onResolved }: {
      queue: Task[];
      onResolved?: (task: Task) => void;
    }) => {
      capturedQueue = queue;
      return () => {
        const task = queue[0]!;
        task.value = "done";
        task.resolve(task.value);
        onResolved?.(task);
        return 1;
      };
    },
  } as unknown as Lock2;

  const tx = createHostTxQueue({
    lock: requestLock,
    returnLock,
    max: 1,
  });

  const promise = tx.enqueue(0)("request");
  assert.equal(tx.completeFrame(), 1);
  assert.equal(await promise, "done");
  assert.equal(capturedQueue?.[0]?.value, null);
});

test("abort-aware promise reject with no reason signals and waits for worker", async () => {
  const requestLock = {
    publish: () => true,
    flushPending: () => false,
    hasPendingFrames: () => false,
    getPendingFrameCount: () => 0,
    getPendingPromiseCount: () => 0,
    resetPendingState: () => {},
  } as unknown as Lock2;

  const setSignals: number[] = [];
  const resetSignals: number[] = [];
  const abortSignals = {
    closeNow: 99,
    getSignal: () => 7,
    setSignal: (signal: number) => {
      setSignals.push(signal);
      return 1 as const;
    },
    resetSignal: (signal: number) => {
      resetSignals.push(signal);
      return true;
    },
  };

  let capturedQueue: Task[] | undefined;
  const returnLock = {
    resolveHost: ({ queue, onResolved }: {
      queue: Task[];
      onResolved?: (task: Task) => void;
    }) => {
      capturedQueue = queue;
      return () => {
        const task = queue[0]!;
        task.value = "worker-result";
        task.resolve(task.value);
        onResolved?.(task);
        return 1;
      };
    },
  } as unknown as Lock2;

  const tx = createHostTxQueue({
    lock: requestLock,
    returnLock,
    max: 1,
    abortSignals,
  });

  const promise = tx.enqueue(0, undefined, true)("request") as
    & Promise<unknown>
    & { reject: (reason?: unknown) => void };
  promise.reject();

  const early = await Promise.race([
    promise.then(() => "settled", () => "rejected"),
    Promise.resolve("pending"),
  ]);

  assert.equal(early, "pending");
  assert.deepEqual(setSignals, [7]);

  assert.equal(tx.completeFrame(), 1);
  assert.equal(await promise, "worker-result");
  assert.deepEqual(resetSignals, [7]);
  assert.equal(capturedQueue?.[0]?.value, null);
});

const completionQueue = (returns: Partial<Lock2>[]) => {
  const lock = {
    publish: () => true,
    flushPending: () => false,
    hasPendingFrames: () => false,
    getPendingFrameCount: () => 0,
    getPendingPromiseCount: () => 0,
    resetPendingState: () => {},
  } as unknown as Lock2;
  const lanes = returns.map((lane) =>
    ({
      resolveHost: () => () => 0,
      ...lane,
    }) as Lock2
  );
  return createHostTxQueue({
    lock,
    returnLock: lanes[0]!,
    extraReturnLocks: lanes.slice(1),
  });
};

test("completion waits reuse idle lanes across preemption and wake the current drain", async () => {
  const arms = [false, false];
  const waits = [0, 0];
  const rearms = [0, 0];
  const releases: Array<() => void> = [];
  const tx = completionQueue(arms.map((_, index) => ({
    armHostNotifier: () => {
      arms[index] = true;
      rearms[index]++;
      return true;
    },
    setHostWaiterArmed: (armed: boolean) => {
      arms[index] = armed;
      if (armed) rearms[index]++;
    },
    waitForHostChange: () => {
      waits[index]++;
      arms[index] = true;
      return {
        async: true,
        value: new Promise<"ok">((resolve) => {
          releases[index] = () => resolve("ok");
        }),
      };
    },
  })));
  let oldWakes = 0;
  let newWakes = 0;
  assert.equal(tx.waitForCompletion(() => oldWakes++), true);
  assert.deepEqual(rearms, [0, 0], "new waits arm themselves");
  releases[0]!();
  await Promise.resolve();
  assert.equal(oldWakes, 1);

  tx.setCompletionWaiterArmed(false);
  assert.equal(tx.waitForCompletion(() => newWakes++), true);
  assert.deepEqual(waits, [2, 1], "lane 1 retains its original waiter");
  assert.deepEqual(rearms, [0, 1]);
  assert.deepEqual(arms, [true, true]);

  releases[1]!();
  await Promise.resolve();
  assert.equal(oldWakes, 1);
  assert.equal(newWakes, 1, "persistent waiter uses the latest wake callback");
  releases[0]!();
  await Promise.resolve();
  assert.equal(newWakes, 2, "reused lane callback handles its new waiter");
  assert.deepEqual(arms, [false, false]);
});

test("a synchronous completion stops arming later lanes after the wake disarms them", () => {
  const arms = [false, false];
  let laterWaits = 0;
  const tx = completionQueue([
    {
      setHostWaiterArmed: (armed) => {
        arms[0] = armed;
      },
      waitForHostChange: () => ({ async: false, value: "not-equal" }),
    },
    {
      setHostWaiterArmed: (armed) => {
        arms[1] = armed;
      },
      waitForHostChange: () => {
        laterWaits++;
        arms[1] = true;
        return { async: true, value: new Promise(() => {}) };
      },
    },
  ]);
  let wakes = 0;
  assert.equal(
    tx.waitForCompletion(() => {
      wakes++;
      tx.setCompletionWaiterArmed(false);
    }),
    true,
  );
  assert.equal(wakes, 1);
  assert.equal(laterWaits, 0);
  assert.deepEqual(arms, [false, false]);
});

for (const throws of [false, true]) {
  test(`unsupported completion lane disarms and invalidates earlier waits (throws=${throws})`, async () => {
    const arms = [false, false];
    let release!: () => void;
    const tx = completionQueue([
      {
        setHostWaiterArmed: (armed) => {
          arms[0] = armed;
        },
        waitForHostChange: () => {
          arms[0] = true;
          return {
            async: true,
            value: new Promise<"ok">((resolve) => {
              release = () => resolve("ok");
            }),
          };
        },
      },
      {
        setHostWaiterArmed: (armed) => {
          arms[1] = armed;
        },
        waitForHostChange: () => {
          if (throws) throw new Error("unsupported buffer");
          return undefined;
        },
      },
    ]);
    let wakes = 0;
    assert.equal(tx.waitForCompletion(() => wakes++), false);
    assert.deepEqual(arms, [false, false]);
    release();
    await Promise.resolve();
    assert.equal(wakes, 0);
  });
}

test("rearming a persistent waiter observes a result published while its gate was off", async () => {
  let armed = false;
  let published = false;
  let release!: () => void;
  let waits = 0;
  const tx = completionQueue([{
    setHostWaiterArmed: (value) => {
      armed = value;
    },
    armHostNotifier: () => {
      armed = !published;
      return !published;
    },
    waitForHostChange: () => {
      waits++;
      armed = true;
      return {
        async: true,
        value: new Promise<"ok">((resolve) => release = () => resolve("ok")),
      };
    },
  }]);
  let wakes = 0;
  const wake = () => {
    wakes++;
    tx.setCompletionWaiterArmed(false);
  };
  assert.equal(tx.waitForCompletion(wake), true);
  tx.setCompletionWaiterArmed(false);
  published = true;
  assert.equal(tx.waitForCompletion(wake), true);
  assert.equal(wakes, 1, "published completion must not wait for the watchdog");
  assert.equal(armed, false);
  assert.equal(waits, 1, "the original waiter remains the only queued waiter");
  release();
  await Promise.resolve();
});

test("a real return publication wakes a rearmed persistent atomic waiter", {
  skip: typeof Atomics.waitAsync !== "function",
}, async () => {
  const returnLock = lock2({ notifyOnHostPublish: true });
  const tx = completionQueue([returnLock]);
  let wakes = 0;
  const wake = () => {
    wakes++;
    tx.setCompletionWaiterArmed(false);
  };
  try {
    assert.equal(tx.waitForCompletion(wake, 1000), true);
    tx.setCompletionWaiterArmed(false);
    const response = makeTask();
    response.value = 7;
    assert.equal(returnLock.encode(response), true);
    // Publication while the gate is off must not wake the old waiter.
    assert.equal(wakes, 0);
    assert.equal(tx.waitForCompletion(wake, 1000), true);
    assert.equal(wakes, 1);
  } finally {
    tx.setCompletionWaiterArmed(false);
    Atomics.notify(returnLock.hostBits, 0);
    // Let the waitAsync callback retire before ending the test.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});
