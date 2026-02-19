import assert from "node:assert/strict";
import test from "node:test";
import { createPool, task } from "../knitting.ts";
import {
  toBigInt,
  toNumber,
  toSet,
  toString,
} from "./fixtures/parameter_tasks.ts";

export const addOnePromise = task<Promise<number> | number, number>({
  f: async (value) => value + 1,
});

const setNumbers = new Set([1, 2, 3, 4, 5, 6]);

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
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
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

test("node:test pool round-trips core payloads", async () => {
  const { call, shutdown } = createPool({
    threads: 2,
  })({
    toNumber,
    toString,
    toBigInt,
    toSet,
  });

  try {
    const results = await withTimeout(
      Promise.all([
        call.toString("hello"),
        call.toNumber(42),
        call.toBigInt(2n ** 64n - 1n),
        call.toSet(setNumbers),
      ]),
      3000,
    );

    assert.equal(results[0], "hello");
    assert.equal(results[1], 42);
    assert.equal(results[2], 2n ** 64n - 1n);
    assert.deepEqual(results[3], setNumbers);
  } finally {
    await shutdown();
  }
});

test("node:test pool awaits promise inputs", async () => {
  const pool = createPool({ threads: 1 })({ addOnePromise });

  try {
    const value = await withTimeout(
      pool.call.addOnePromise(Promise.resolve(41)),
      3000,
    );
    assert.equal(value, 42);
  } finally {
    await pool.shutdown();
  }
});
