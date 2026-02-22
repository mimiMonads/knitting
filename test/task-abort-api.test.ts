import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../knitting.ts";
import { abortA, abortB, abortC } from "./fixtures/abort_tasks.ts";

test("task API abortSignal tasks reject when pool shuts down", async () => {
  const { call, shutdown } = createPool({ threads: 1 })({
    abortA,
    abortB,
    abortC,
  });

  const pending = [
    call.abortA(),
    call.abortB(),
    call.abortC(),
  ];
  const settledPromise = Promise.allSettled(pending);
  await shutdown();

  const settled = await settledPromise;
  assert.equal(settled.length, 3);
  assert.equal(
    settled.every((entry) => entry.status === "rejected"),
    true,
  );

  for (const entry of settled) {
    if (entry.status !== "rejected") continue;
    assert.equal(String(entry.reason), "Thread closed");
  }
});
