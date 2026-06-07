import assert from "node:assert/strict";
import { createPool } from "../../../knitting.ts";
import { addOnePromise } from "../runtime_tasks.ts";

const pool = createPool({
  threads: 1,
  debug: { host: true },
})({ addOnePromise });

try {
  assert.equal(await pool.call.addOnePromise(41), 42);
  console.log("probe-ok host-debug");
} finally {
  await pool.shutdown();
}
