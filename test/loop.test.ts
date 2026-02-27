import assert from "node:assert/strict";
import test from "node:test";
const assertEquals: (actual: unknown, expected: unknown) => void =
  (actual, expected) => {
    assert.deepStrictEqual(actual, expected);
  };
import { createPool } from "../knitting.ts";
import { addOne, delayedEcho } from "./fixtures/loop_tasks.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(promise: Promise<T>, ms: number) => {
  let timeoutId ;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`test timeout after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

test("worker loop progresses across async work and idle periods", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    worker: {
      timers: {
        spinMicroseconds: 10,
        parkMs: 5,
      },
    },
    host: {
      stallFreeLoops: 0,
      maxBackoffMs: 1,
    },
  })({ addOne, delayedEcho });

  try {
    const batch1 = [
      call.addOne(1),
      call.addOne(2),
      call.delayedEcho(5),
    ];
    const result1 = await withTimeout(Promise.all(batch1), 2000);
    assertEquals(result1, [2, 3, 5]);

    // Let the worker go idle, then enqueue another batch to verify wakeup.
    await delay(5);

    const batch2 = [
      call.delayedEcho(2),
      call.addOne(40),
      call.addOne(-1),
    ];
    const result2 = await withTimeout(Promise.all(batch2), 2000);
    assertEquals(result2, [2, 41, 0]);
  } finally {
    await shutdown();
  }
});

test("shutdown supports delayed termination timer", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
  })({ addOne });

  const value = await call.addOne(1);
  assertEquals(value, 2);

  const startedAt = Date.now();
  await shutdown(60);
  const elapsed = Date.now() - startedAt;
  assert.equal(elapsed >= 40, true);
});
