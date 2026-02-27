import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../knitting.ts";
import {
  mutateCastOnValue,
  mutateCastOnObjectValue,
  mutateCastOnExistingGlobal,
  readCastOnObjectValue,
  readCastOnExistingGlobal,
  readCastOnAsyncValue,
  readCastOnValue,
  setupCastOnObjectValue,
  setupCastOnExistingGlobal,
  setupCastOnAsyncValue,
  setupCastOnTopLevelValue,
  setupCastOnValue,
} from "./fixtures/caston_tasks.ts";
import { readCastOnTopLevelMutation } from "./fixtures/caston_top_level_tasks.ts";

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
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

test("castOn runs before task execution and freezes cast-on globals", async () => {
  const pool = createPool({
    threads: 1,
    castOn: setupCastOnValue,
  })({
    readCastOnValue,
    mutateCastOnValue,
  });

  try {
    const first = await withTimeout(pool.call.readCastOnValue(), 2000);
    assert.equal(first, 41);

    const mutate = await withTimeout(pool.call.mutateCastOnValue(), 2000);
    assert.equal(mutate === "mutated", false);

    const second = await withTimeout(pool.call.readCastOnValue(), 2000);
    assert.equal(second, 41);
  } finally {
    await pool.shutdown();
  }
});

test("castOn supports async setup functions", async () => {
  const pool = createPool({
    threads: 1,
    castOn: setupCastOnAsyncValue,
  })({
    readCastOnAsyncValue,
  });

  try {
    const value = await withTimeout(pool.call.readCastOnAsyncValue(), 2000);
    assert.equal(value, "ready");
  } finally {
    await pool.shutdown();
  }
});

test("castOn freezes assigned object globals", async () => {
  const pool = createPool({
    threads: 1,
    castOn: setupCastOnObjectValue,
  })({
    readCastOnObjectValue,
    mutateCastOnObjectValue,
  });

  try {
    const before = await withTimeout(pool.call.readCastOnObjectValue(), 2000);
    assert.equal(before.count, 1);
    assert.equal(before.hasInjected, false);

    const mutate = await withTimeout(pool.call.mutateCastOnObjectValue(), 2000);
    assert.equal(mutate === "mutated", false);

    const after = await withTimeout(pool.call.readCastOnObjectValue(), 2000);
    assert.equal(after.count, 1);
    assert.equal(after.hasInjected, false);
  } finally {
    await pool.shutdown();
  }
});

test("castOn works when inliner is enabled", async () => {
  const pool = createPool({
    threads: 1,
    inliner: {
      position: "first",
    },
    castOn: setupCastOnValue,
  })({
    readCastOnValue,
  });

  try {
    const value = await withTimeout(pool.call.readCastOnValue(), 2000);
    assert.equal(value, 41);
  } finally {
    await pool.shutdown();
  }
});

test("castOn freeze blocks task-module top-level mutation before task execution", async () => {
  const pool = createPool({
    threads: 1,
    castOn: setupCastOnTopLevelValue,
  })({
    readCastOnTopLevelMutation,
  });

  try {
    const result = await withTimeout(pool.call.readCastOnTopLevelMutation(), 2000);
    assert.equal(result.value, 41);
    assert.equal(result.topLevelMutationState === "mutated", false);
  } finally {
    await pool.shutdown();
  }
});

test("castOn overwrite of an existing global stays immutable", async () => {
  const pool = createPool({
    threads: 1,
    castOn: setupCastOnExistingGlobal,
  })({
    readCastOnExistingGlobal,
    mutateCastOnExistingGlobal,
  });

  try {
    const before = await withTimeout(pool.call.readCastOnExistingGlobal(), 2000);
    if (before.ready !== true) return;

    assert.equal(before.name, "castOnAtob");
    const mutate = await withTimeout(pool.call.mutateCastOnExistingGlobal(), 2000);
    assert.equal(mutate === "taskAtob", false);

    const after = await withTimeout(pool.call.readCastOnExistingGlobal(), 2000);
    assert.equal(after.name, "castOnAtob");
  } finally {
    await pool.shutdown();
  }
});
