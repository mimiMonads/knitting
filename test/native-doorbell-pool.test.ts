import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { RUNTIME } from "../src/common/runtime.ts";
import { double } from "./fixtures/steal_tasks.ts";

test("experimental native completion doorbell completes thread-worker calls", {
  skip: RUNTIME !== "node" && RUNTIME !== "bun",
}, async () => {
  const pool = createPool({
    threads: 1,
    host: {
      doorbell: true,
      nativeDoorbell: true,
      stallFreeLoops: 0,
    },
  })({ double });

  try {
    const values = await Promise.all(
      Array.from({ length: 64 }, (_, value) => pool.call.double(value)),
    );
    assert.deepEqual(values, Array.from({ length: 64 }, (_, value) => value * 2));
  } finally {
    await pool.shutdown();
  }
});
