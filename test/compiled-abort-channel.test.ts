import assert from "node:assert/strict";
import { createCompiledAbortChannel } from "../src/runtime/compiled-worker.ts";
import test from "./_runner.ts";

test("compiled abort channel sets, recycles, and bounds slots", () => {
  const channel = createCompiledAbortChannel(2);
  try {
    const first = channel.getSignal();
    const second = channel.getSignal();

    assert.equal(first, 0);
    assert.equal(second, 1);
    assert.equal(channel.getSignal(), channel.closeNow);
    assert.equal(channel.hasAborted(first), false);
    assert.equal(channel.setSignal(first), 1);
    assert.equal(channel.hasAborted(first), true);
    assert.equal(channel.resetSignal(first), true);
    assert.equal(channel.hasAborted(first), false);
    assert.equal(channel.resetSignal(first), false);
    assert.equal(channel.getSignal(), 0);
    assert.equal(channel.environment.KNITTING_COMPILED_ABORT_BYTES, "4");
  } finally {
    channel.close();
  }
});
