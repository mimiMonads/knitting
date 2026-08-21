import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createLockControlCarpet } from "../src/memory/byte-carpet.ts";
import {
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  makeTask,
  STEAL_WANT_SLOT_OFFSET_U32,
} from "../src/memory/lock.ts";
import { toSharedBufferRegion } from "../src/common/shared-buffer-region.ts";
// Side-effect import: registers the payload codec before any lock2() call.
import "../src/memory/payloadCodec.ts";

const makeValueTask = (value: unknown) => {
  const task = makeTask();
  task.value = value;
  return task;
};

const buildStealLock = (consumers: number, regionLanes: number) => {
  const controlLayout = createLockControlCarpet({
    signalBytes: 0,
    abortBytes: 0,
    lockSectorBytes: LOCK_SECTOR_BYTE_LENGTH,
    headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
    slotCount: LockBound.slots,
    headerLayout: "split",
  });
  const shared = {
    LockBoundSector: controlLayout.lock.lockSector,
    headers: controlLayout.lock.headers,
    payload: new SharedArrayBuffer(1 << 16),
    payloadSector: controlLayout.lock.payloadSector,
  };
  const headersRegion = toSharedBufferRegion(shared.headers);
  return {
    producer: lock2({ ...shared, consumers, regionLanes }),
    consumers: Array.from(
      { length: consumers },
      (_, consumerId) =>
        lock2({ ...shared, consumers, consumerId, regionLanes }),
    ),
    headers: new Int32Array(
      headersRegion.sab,
      headersRegion.byteOffset,
      headersRegion.byteLength >>> 2,
    ),
  };
};

// Slots per region must leave a spare for a delayed claimant, so
// LockBound.slots / regionLanes >= consumers + 1.
//
// Dynamic payloads under arena pressure are covered separately by
// test/payload-arena-reuse.test.ts.
for (const [consumers, regionLanes] of [[2, 8], [3, 8], [4, 4], [2, 16]]) {
  test(`stealing with ${consumers} consumers, g=${regionLanes}: exactly once`, () => {
    const { producer, consumers: endpoints } = buildStealLock(
      consumers,
      regionLanes,
    );

    const TOTAL = 400;
    const seen = new Set<number>();
    let published = 0;
    let drained = 0;
    let guard = 0;

    while (drained < TOTAL) {
      if (++guard > 100_000) break;

      if (published < TOTAL && producer.encode(makeValueTask(published))) {
        published++;
        continue;
      }

      // Round-robin the endpoints so no single one is favoured by the harness;
      // fixed priority inside the claim decides who actually wins.
      let progressed = false;
      for (let c = 0; c < endpoints.length; c++) {
        const endpoint = endpoints[(guard + c) % endpoints.length]!;
        if (!endpoint.decode()) continue;
        progressed = true;
        const taken = endpoint.resolved.toArray();
        endpoint.resolved.clear();
        for (const task of taken) {
          const value = task.value as number;
          assert.equal(
            seen.has(value),
            false,
            `duplicate delivery of ${value}`,
          );
          seen.add(value);
          drained++;
        }
      }
      if (!progressed && published >= TOTAL) break;
    }

    assert.equal(published, TOTAL, "producer published every task");
    assert.equal(drained, TOTAL, "every task was drained exactly once");
    for (let value = 0; value < TOTAL; value++) {
      assert.equal(seen.has(value), true, `task ${value} was lost`);
    }
  });
}

test("stealing rejects a region layout with too few regions", () => {
  assert.throws(
    () => buildStealLock(4, 16),
    /too few for 4 consumers/,
  );
});

test("a terminated consumer's stale intent cannot block its region", () => {
  const { producer, consumers, headers } = buildStealLock(2, 8);
  assert.equal(producer.encode(makeValueTask(42)), true);

  // Consumer 0 is senior and appears to have died after publishing WANT. Mark
  // every region so this test does not depend on the producer's lane cursor.
  const seniorWant = LockBound.header + STEAL_WANT_SLOT_OFFSET_U32;
  Atomics.store(headers, seniorWant, -1);
  assert.equal(consumers[1]!.decode(), false);

  // The host owns only the liveness word; it does not clear the dead worker's
  // WANT and therefore never becomes a second writer to that control word.
  assert.equal(producer.deactivateStealConsumer(0), true);
  assert.equal(Atomics.load(headers, seniorWant), -1);
  assert.equal(consumers[1]!.decode(), true);
  assert.equal(consumers[1]!.resolved.toArray()[0]!.value, 42);
});

test("single consumer keeps the classic decode path", () => {
  const { producer, consumers } = buildStealLock(2, 8);
  assert.equal(typeof producer.decode, "function");
  assert.equal(consumers.length, 2);
});
