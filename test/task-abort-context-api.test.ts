import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../knitting.ts";
import { abortContextProbe } from "./fixtures/abort_context_tasks.ts";

const isBun = typeof process !== "undefined" && !!process.versions?.bun;
const runtimeTest = isBun ? test.skip : test;

// Bun may segfault here for reasons that are still unclear.
// Skipping it in Bun for now and revisiting this later.
runtimeTest("task API provides abort toolkit context for object abortSignal config", async () => {
  const { call, shutdown } = createPool({ threads: 1 })({
    abortContextProbe,
  });

  try {
    assert.equal(await call.abortContextProbe(), 0);
  } finally {
    await shutdown();
  }
});
