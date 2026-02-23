import assert from "node:assert/strict";
import test from "node:test";
import { withResolvers } from "../src/common/with-resolvers.ts";
import { OneShotDeferred, signalAbortFactory } from "../src/shared/abortSignal.ts";

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

test("abortAll mirrors in-use slots into shared aborted view", () => {
  const sab = new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT * 2);
  const store = signalAbortFactory({ sab });

  const allocated = Array.from({ length: 33 }, () => store.getSignal());
  assert.equal(store.inUseCount(), 33);
  assert.equal(store.abortAll(), 33);

  assert.equal(store.hasAborted(allocated[0]!), true);
  assert.equal(store.hasAborted(allocated[31]!), true);
  assert.equal(store.hasAborted(allocated[32]!), true);
  const untouched = Array.from(
    { length: store.max },
    (_, signal) => signal,
  ).find((signal) => !allocated.includes(signal));
  assert.equal(store.hasAborted(untouched!), false);

  assert.equal(store.resetSignal(allocated[31]!), true);
  const recycled = store.getSignal();
  assert.equal(recycled, allocated[31]);
  assert.equal(store.hasAborted(recycled), false);
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

test("OneShotDeferred reject wrapper is single-fire", async () => {
  const deferred = withResolvers<unknown>();
  let settles = 0;
  new OneShotDeferred(deferred, () => {
    settles++;
  });

  deferred.reject("first");
  deferred.reject("second");
  deferred.resolve("late");

  await assert.rejects(deferred.promise, (reason) => reason === "first");
  assert.equal(settles, 1);
});
