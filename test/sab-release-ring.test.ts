import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  createSabReleaseConsumer,
  createSabReleasePublisher,
  createSabReleaseRingBuffer,
} from "../src/memory/sab-release-ring.ts";

const drainAll = (consumer: ReturnType<typeof createSabReleaseConsumer>) => {
  const seen: bigint[] = [];
  consumer.drain((token) => seen.push(token));
  return seen;
};

test("release ring round-trips tokens in order", () => {
  const sab = createSabReleaseRingBuffer(8);
  const publisher = createSabReleasePublisher(sab);
  const consumer = createSabReleaseConsumer(sab);

  assert.deepEqual(consumer.hasPending(), false);
  for (const token of [1n, 2n, 0xdeadbeefn]) publisher.publish(token);
  assert.deepEqual(consumer.hasPending(), true);
  assert.deepEqual(drainAll(consumer), [1n, 2n, 0xdeadbeefn]);
  assert.deepEqual(consumer.hasPending(), false);
  assert.deepEqual(drainAll(consumer), []);
});

test("release ring survives u64 tokens above 2^32", () => {
  const sab = createSabReleaseRingBuffer(4);
  const publisher = createSabReleasePublisher(sab);
  const consumer = createSabReleaseConsumer(sab);
  const token = (0x89abcdefn << 32n) | 0x76543210n;
  publisher.publish(token);
  assert.deepEqual(drainAll(consumer), [token]);
});

test("release ring parks overflow instead of dropping tokens", () => {
  const sab = createSabReleaseRingBuffer(4);
  const publisher = createSabReleasePublisher(sab);
  const consumer = createSabReleaseConsumer(sab);

  for (let i = 1n; i <= 4n; i++) assert.deepEqual(publisher.publish(i), true);
  assert.deepEqual(publisher.publish(5n), false);
  assert.deepEqual(publisher.publish(6n), false);
  assert.deepEqual(publisher.pending, 2);

  assert.deepEqual(drainAll(consumer), [1n, 2n, 3n, 4n]);
  assert.deepEqual(publisher.flush(), true);
  assert.deepEqual(publisher.pending, 0);
  assert.deepEqual(drainAll(consumer), [5n, 6n]);
});

test("release ring keeps order when overflow drains on the next publish", () => {
  const sab = createSabReleaseRingBuffer(4);
  const publisher = createSabReleasePublisher(sab);
  const consumer = createSabReleaseConsumer(sab);

  for (let i = 1n; i <= 6n; i++) publisher.publish(i);
  assert.deepEqual(drainAll(consumer), [1n, 2n, 3n, 4n]);
  publisher.publish(7n);
  assert.deepEqual(drainAll(consumer), [5n, 6n, 7n]);
});

test("release ring wraps past its slot count", () => {
  const sab = createSabReleaseRingBuffer(4);
  const publisher = createSabReleasePublisher(sab);
  const consumer = createSabReleaseConsumer(sab);

  for (let round = 0n; round < 10n; round++) {
    const token = round * 100n + 1n;
    publisher.publish(token);
    assert.deepEqual(drainAll(consumer), [token]);
  }
});
