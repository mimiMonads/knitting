import assert from "node:assert/strict";
import test from "node:test";
import { signalAbortFactory } from "../src/shared/abortSignal.ts";

test("abort signal set/check/reset lifecycle", () => {
  const sab = new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT);
  const store = signalAbortFactory({ sab });

  const signal = store.getSignal();
  assert.equal(signal, 0);
  assert.equal(store.hasAborted(signal), false);

  assert.equal(store.setSignal(signal), 1);
  assert.equal(store.hasAborted(signal), true);

  // Abort is monotonic; repeated set does not toggle back.
  assert.equal(store.setSignal(signal), 1);
  assert.equal(store.hasAborted(signal), true);

  assert.equal(store.resetSignal(signal), true);
  assert.equal(store.hasAborted(signal), false);

  const recycled = store.getSignal();
  assert.equal(recycled, signal);

  assert.equal(store.setSignal(-1), -1);
});

test("closeNow sentinel when pool is exhausted", () => {
  const sab = new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT);
  const store = signalAbortFactory({ sab });

  const allocated = Array.from({ length: 32 }, () => store.getSignal());
  assert.deepEqual(allocated, Array.from({ length: 32 }, (_, i) => i));
  assert.equal(store.inUseCount(), 32);

  const exhausted = store.getSignal();
  assert.equal(exhausted, store.closeNow);
  assert.equal(store.hasAborted(store.closeNow), true);
  assert.equal(store.setSignal(store.closeNow), 0);
  assert.equal(store.resetSignal(store.closeNow), false);
});
