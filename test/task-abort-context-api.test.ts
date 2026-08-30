import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { abortContextProbe } from "./fixtures/abort_context_tasks.ts";

// Bun used to segfault here at random; re-enabled on bun 1.4.0 after 40+
// clean runs (isolated and in the full suite). Re-gate on bun if it returns.
test(
  "task API provides abort toolkit context for object abortSignal config",
  async () => {
    const { call, shutdown } = createPool({ threads: 1 })({
      abortContextProbe,
    });

    try {
      assert.equal(await call.abortContextProbe(), 0);
    } finally {
      await shutdown();
    }
  },
);
