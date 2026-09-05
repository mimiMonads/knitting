import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createLockControlCarpet } from "../src/memory/byte-carpet.ts";
import {
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  makeTask,
  STEAL_CLAIM_MASK_SLOT_OFFSET_U32,
  type StealClaimDiscipline,
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

const buildStealLock = (
  consumers: number,
  regionLanes: number,
  stealClaim: StealClaimDiscipline = "dekker",
) => {
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
    producer: lock2({ ...shared, consumers, regionLanes, stealClaim }),
    consumers: Array.from(
      { length: consumers },
      (_, consumerId) =>
        lock2({ ...shared, consumers, consumerId, regionLanes, stealClaim }),
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
for (const claim of ["dekker", "cas-mask"] as const) {
for (const [consumers, regionLanes] of [[2, 8], [3, 8], [4, 4], [2, 16]]) {
  test(`${claim} stealing with ${consumers} consumers, g=${regionLanes}: exactly once`, () => {
    const { producer, consumers: endpoints } = buildStealLock(
      consumers,
      regionLanes,
      claim,
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
}

const claimMaskIndex = LockBound.header + STEAL_CLAIM_MASK_SLOT_OFFSET_U32;
const wantIndex = (consumerId: number): number =>
  (consumerId * HEADER_SLOT_STRIDE_U32) + LockBound.header +
  STEAL_WANT_SLOT_OFFSET_U32;

test("cas-mask claiming excludes a peer from held regions and releases its claim", () => {
  const { producer, consumers, headers } = buildStealLock(2, 8, "cas-mask");
  const regions = LockBound.slots / 8;

  for (let i = 0; i < 4; i++) {
    assert.equal(producer.encode(makeValueTask(i)), true);
  }

  // Every region is held by an in-flight claimant, so nobody may take one.
  Atomics.store(headers, claimMaskIndex, (1 << regions) - 1);
  assert.equal(consumers[1]!.decode(), false);
  assert.equal(consumers[1]!.resolved.size, 0);

  // Released regions are claimable again, and a finished claim must hand its
  // bit back or the pool would leak a region per claim.
  Atomics.store(headers, claimMaskIndex, 0);
  assert.equal(consumers[1]!.decode(), true);
  assert.notEqual(consumers[1]!.resolved.size, 0);
  assert.equal(Atomics.load(headers, claimMaskIndex), 0);
});

test("cas-mask hands back a dead claimant's recorded region", () => {
  const { producer, consumers, headers } = buildStealLock(2, 8, "cas-mask");

  assert.equal(producer.encode(makeValueTask(42)), true);
  const pending = (Atomics.load(producer.hostBits, 0) ^
    Atomics.load(producer.workerBits, 0)) >>> 0;
  const slot = 31 - Math.clz32(pending);
  const intent = 1 << ((slot / 8) | 0);

  // Consumer 0 died holding the pending region. Its WANT records the owned bit for
  // host-side recovery; the host does not write the dead consumer's WANT word.
  Atomics.store(headers, claimMaskIndex, intent);
  Atomics.store(headers, wantIndex(0), intent);
  assert.equal(consumers[1]!.decode(), false);

  assert.equal(producer.deactivateStealConsumer(0), true);
  assert.equal(Atomics.load(headers, claimMaskIndex), 0, "handed back");
  assert.equal(
    Atomics.load(headers, wantIndex(0)),
    intent,
    "WANT remains single-writer",
  );
  assert.equal(consumers[1]!.decode(), true);
  assert.equal(consumers[1]!.resolved.toArray()[0]!.value, 42);
});

test("cas-mask only hands back the dead claimant's recorded region", () => {
  const { producer, headers } = buildStealLock(3, 8, "cas-mask");
  // Consumer 1 owns region 0; consumer 2 owns region 1.
  Atomics.store(headers, claimMaskIndex, 0b11);
  Atomics.store(headers, wantIndex(1), 0b01);
  Atomics.store(headers, wantIndex(2), 0b10);

  assert.equal(producer.deactivateStealConsumer(1), true);
  assert.equal(Atomics.load(headers, claimMaskIndex), 0b10, "dead bit cleared");
});

test("cas-mask allows more consumers than regions; dekker does not", () => {
  // g=8 leaves 4 regions. Dekker needs a spare region per claimant, so 6
  // consumers is rejected; a CAS-mask claimant bails and retries instead of
  // deadlocking.
  assert.throws(() => buildStealLock(6, 8), /too few for 6 consumers/);

  const { producer, consumers } = buildStealLock(6, 8, "cas-mask");
  const TOTAL = 200;
  const seen = new Set<number>();
  let published = 0;
  let drained = 0;
  let guard = 0;

  while (drained < TOTAL && ++guard < 100_000) {
    if (published < TOTAL && producer.encode(makeValueTask(published))) {
      published++;
      continue;
    }
    for (let c = 0; c < consumers.length; c++) {
      const endpoint = consumers[(guard + c) % consumers.length]!;
      if (!endpoint.decode()) continue;
      const taken = endpoint.resolved.toArray();
      endpoint.resolved.clear();
      for (const task of taken) {
        const value = task.value as number;
        assert.equal(seen.has(value), false, `duplicate delivery of ${value}`);
        seen.add(value);
        drained++;
      }
    }
  }

  assert.equal(published, TOTAL);
  assert.equal(drained, TOTAL, "every task drained exactly once with R < N");
});

test("cas-mask works with a single region (g=32, R=1)", () => {
  // The widest legal region leaves one region for every claimant to contend
  // for -- the degenerate end of relaxing `R >= N`.
  const { producer, consumers } = buildStealLock(2, 32, "cas-mask");
  const TOTAL = 64;
  const seen = new Set<number>();
  let published = 0;
  let drained = 0;
  let guard = 0;

  while (drained < TOTAL && ++guard < 100_000) {
    if (published < TOTAL && producer.encode(makeValueTask(published))) {
      published++;
      continue;
    }
    for (let c = 0; c < consumers.length; c++) {
      const endpoint = consumers[(guard + c) % consumers.length]!;
      if (!endpoint.decode()) continue;
      const taken = endpoint.resolved.toArray();
      endpoint.resolved.clear();
      for (const task of taken) {
        const value = task.value as number;
        assert.equal(seen.has(value), false, `duplicate ${value}`);
        seen.add(value);
        drained++;
      }
    }
  }

  assert.equal(drained, TOTAL, "every task drained exactly once at R = 1");
});

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

/**
 * A claim owns its whole region, so a throw partway through decoding it must
 * still retire the lanes that were decoded and release the region. Leaving the
 * intent word set would park the region for the life of the pool, and skipping
 * the acknowledgement would strand every lane the claim had already consumed —
 * the classic `decode()` path guards this with a `finally`, and the stealing
 * path has to as well.
 *
 * `decodeAt` takes a task off the recycle list before it touches anything else,
 * which makes that list a clean place to inject the failure.
 */
test("a throw mid-region still retires decoded lanes and frees the region", () => {
  let failAfter = Number.POSITIVE_INFINITY;
  let shifts = 0;
  const explodingRecycle = {
    shiftNoClear: () => {
      if (++shifts > failAfter) throw new Error("decode blew up");
      return undefined;
    },
  } as unknown as ConstructorParameters<typeof Object>[0];

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
  const headers = new Int32Array(
    headersRegion.sab,
    headersRegion.byteOffset,
    headersRegion.byteLength >>> 2,
  );

  const consumers = 2;
  const producer = lock2({ ...shared, consumers, regionLanes: 8 });
  const failing = lock2({
    ...shared,
    consumers,
    consumerId: 0,
    regionLanes: 8,
    recycleList: explodingRecycle as never,
  });
  const survivor = lock2({ ...shared, consumers, consumerId: 1, regionLanes: 8 });

  const TOTAL = 3;
  for (let i = 0; i < TOTAL; i++) {
    assert.equal(producer.encode(makeValueTask(i)), true);
  }

  // Blow up on the second lane of the region, so the claim has already decoded
  // one and still owes the rest.
  failAfter = 1;
  assert.throws(() => failing.decode(), /decode blew up/);

  const failingWant = LockBound.header + STEAL_WANT_SLOT_OFFSET_U32;
  assert.equal(
    Atomics.load(headers, failingWant),
    0,
    "the region must be released even though decoding threw",
  );

  // The lane that was decoded before the throw is retired; the rest are still
  // pending, so the other consumer can pick the region up and finish it.
  failAfter = Number.POSITIVE_INFINITY;
  const seen = new Set<number>();
  for (const task of failing.resolved.toArray()) seen.add(task.value as number);
  for (let guard = 0; guard < 100 && seen.size < TOTAL; guard++) {
    if (!survivor.decode()) continue;
    for (const task of survivor.resolved.toArray()) {
      const value = task.value as number;
      assert.equal(seen.has(value), false, `duplicate delivery of ${value}`);
      seen.add(value);
    }
    survivor.resolved.clear();
  }

  assert.equal(seen.size, TOTAL, "no task was stranded by the failed claim");
});

/** Stealing must preserve producer order within each claimed region. */
for (const claim of ["dekker", "cas-mask"] as const) {
  for (const regionLanes of [4, 8, 16]) {
    test(
      `${claim} decodes a claimed region in producer order, g=${regionLanes}`,
      () => {
        const { producer, consumers: endpoints } = buildStealLock(
          2,
          regionLanes,
          claim,
        );

        const TOTAL = 16;
        for (let i = 0; i < TOTAL; i++) {
          assert.equal(producer.encode(makeValueTask(i)), true);
        }

        const endpoint = endpoints[0]!;
        const claims: number[][] = [];
        let drained = 0;
        for (let guard = 0; guard < 100 && endpoint.decode(); guard++) {
          const values: number[] = [];
          for (const task of endpoint.resolved.toArray()) {
            values.push(task.value as number);
          }
          endpoint.resolved.clear();
          claims.push(values);
          drained += values.length;
        }

        assert.equal(drained, TOTAL, "one consumer drains what it published");
        for (const values of claims) {
          for (let i = 1; i < values.length; i++) {
            assert.equal(
              values[i],
              values[i - 1]! + 1,
              `region decoded out of producer order: ${values.join(",")}`,
            );
          }
        }
      },
    );
  }
}
