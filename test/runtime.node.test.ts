import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../knitting.ts";
import {
  toBigInt,
  toNumber,
  toString,
} from "./fixtures/parameter_tasks.ts";
import {
  addOnePromise,
  addOnePromiseViaPath,
} from "./fixtures/runtime_tasks.ts";
import {
  returnFunction,
  returnLocalSymbol,
  returnWeakMap,
} from "./fixtures/error_tasks.ts";

const TEST_TIMEOUT_MS = 10_000;

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

test("node:test pool round-trips core payloads", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { call, shutdown } = createPool({
    threads: 2,
  })({
    toNumber,
    toString,
    toBigInt,
  });

  try {
    const results = await withTimeout(
      Promise.all([
        call.toString("hello"),
        call.toNumber(42),
        call.toBigInt(2n ** 64n - 1n),
      ]),
      TEST_TIMEOUT_MS,
    );

    assert.equal(results[0], "hello");
    assert.equal(results[1], 42);
    assert.equal(results[2], 2n ** 64n - 1n);
  } finally {
    await shutdown();
  }
});

test("node:test pool awaits promise inputs", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const pool = createPool({ threads: 1 })({ addOnePromise });

  try {
    const value = await withTimeout(
      pool.call.addOnePromise(Promise.resolve(41)),
      TEST_TIMEOUT_MS,
    );
    assert.equal(value, 42);
  } finally {
    await pool.shutdown();
  }
});

test("node:test pool imports task module from filesystem href", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const pool = createPool({ threads: 1 })({ addOnePromiseViaPath });

  try {
    const value = await withTimeout(
      pool.call.addOnePromiseViaPath(Promise.resolve(10)),
      TEST_TIMEOUT_MS,
    );
    assert.equal(value, 11);
  } finally {
    await pool.shutdown();
  }
});

test("node:test pool rejects when worker cannot encode returned payload", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const pool = createPool({ threads: 1 })({
    returnLocalSymbol,
    returnFunction,
    returnWeakMap,
  });

  try {
    await assert.rejects(
      withTimeout(pool.call.returnLocalSymbol(), TEST_TIMEOUT_MS),
      (error: unknown) => String(error).includes("KNT_ERROR_1"),
    );

    await assert.rejects(
      withTimeout(pool.call.returnFunction(), TEST_TIMEOUT_MS),
      (error: unknown) => String(error).includes("KNT_ERROR_0"),
    );

    await assert.rejects(
      withTimeout(pool.call.returnWeakMap(), TEST_TIMEOUT_MS),
      (error: unknown) => String(error).includes("KNT_ERROR_3"),
    );
  } finally {
    await pool.shutdown();
  }
});
