import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { RUNTIME } from "../src/common/runtime.ts";
import { plainStamped, sharedStamped } from "./fixtures/shared_return_tasks.ts";

// Borrowed regions live in the payload arena, which a process worker maps too,
// so unlike the pointer payloads this path is not thread-worker-only. That is
// the claim; this is the test for it.
const BIG = 256 * 1024;
const pack = (stamp: number, bytes: number): number => (stamp << 21) | bytes;

test("borrowed returns cross a process worker", async () => {
  if (typeof SharedArrayBuffer !== "function") return;
  if (RUNTIME !== "node" && RUNTIME !== "deno" && RUNTIME !== "bun") return;

  const pool = createPool({
    threads: 1,
    worker: { runtime: "process", processRuntime: RUNTIME },
    payload: { payloadMaxByteLength: 16 * 1024 * 1024 },
  })({ plainStamped, sharedStamped });
  try {
    for (let stamp = 1; stamp <= 4; stamp++) {
      const shared = await pool.call.sharedStamped(pack(stamp, BIG));
      assert.equal(shared.byteLength, BIG);
      assert.equal(shared[BIG - 1], stamp);

      const plain = await pool.call.plainStamped(pack(stamp, BIG));
      assert.equal(plain.byteLength, BIG);
      assert.equal(plain[BIG - 1], stamp);
    }
  } finally {
    await pool.shutdown();
  }
});
