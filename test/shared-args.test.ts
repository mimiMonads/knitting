import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { echoArgShape } from "./fixtures/shared_return_tasks.ts";

const supported = typeof SharedArrayBuffer === "function";
const BIG = 256 * 1024;

// The worker reports whether it was handed a view over shared memory or a
// private copy, which is the only externally visible difference between the two
// argument paths.
const SHARED = 1;
const COPIED = 0;

test("sharedArgBytes hands the worker a view over the submit arena", async () => {
  if (!supported) return;
  const pool = createPool({ threads: 2, unsafe: { SharedArgs: true } })({
    echoArgShape,
  });
  try {
    const arg = pool.sharedArgBytes(BIG);
    assert.ok(
      arg.buffer instanceof SharedArrayBuffer,
      "sharedArgBytes must allocate in the arena when SharedArgs is on",
    );
    arg.fill(9);
    assert.deepEqual(await pool.call.echoArgShape(arg), [SHARED, BIG, 9]);
  } finally {
    await pool.shutdown();
  }
});

test("a prefix of an argument region is sent without a copy", async () => {
  if (!supported) return;
  const pool = createPool({ threads: 2, unsafe: { SharedArgs: true } })({
    echoArgShape,
  });
  try {
    const arg = pool.sharedArgBytes(BIG);
    arg.fill(4, 0, 1024);
    assert.deepEqual(
      await pool.call.echoArgShape(arg.subarray(0, 1024)),
      [SHARED, 1024, 4],
    );
  } finally {
    await pool.shutdown();
  }
});

test("without SharedArgs, arguments stay private copies", async () => {
  if (!supported) return;
  const pool = createPool({ threads: 2 })({ echoArgShape });
  try {
    const arg = pool.sharedArgBytes(BIG);
    assert.ok(
      !(arg.buffer instanceof SharedArrayBuffer),
      "sharedArgBytes falls back to a plain allocation when not enabled",
    );
    arg.fill(3);
    assert.deepEqual(await pool.call.echoArgShape(arg), [COPIED, BIG, 3]);
  } finally {
    await pool.shutdown();
  }
});
