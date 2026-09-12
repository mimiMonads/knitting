import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createLockControlCarpet } from "../src/memory/byte-carpet.ts";
import {
  assertStealClaim,
  DEFAULT_STEAL_CLAIM,
  DOORBELL_ARMED_SLOT_OFFSET_U32,
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  makeTask,
  STEAL_TICKET_HEAD_SLOT_OFFSET_U32,
  STEAL_TICKET_ORDER_SLOT_OFFSET_U32,
  STEAL_TICKET_FAILED,
  type StealClaimDiscipline,
  STEAL_WANT_SLOT_OFFSET_U32,
  STEAL_LIVE_SLOT_OFFSET_U32,
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
    shared,
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
for (const claim of ["dekker", "ticket"] as const) {
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

test("stealing rejects a region layout with too few regions", () => {
  assert.throws(
    () => buildStealLock(4, 16),
    /too few for 4 consumers/,
  );
});

// Baseline Dekker fixtures: seniority is global consumer ID.
const wantU32 = (consumer: number): number =>
  consumer * HEADER_SLOT_STRIDE_U32 + LockBound.header +
  STEAL_WANT_SLOT_OFFSET_U32;
const liveU32 = LockBound.header + STEAL_LIVE_SLOT_OFFSET_U32;

type TracedOp = { op: string; word: string };

type AtomicView = { byteOffset: number; BYTES_PER_ELEMENT: number };

/**
 * Build endpoints whose shared-memory operations can be recorded.
 *
 * Cost and safety both live in operations that leave nothing behind: an intent
 * published and cleared inside one call reads as zero either way, so counting
 * is the only way to assert "no `WANT` was read" or "exactly two arbitration
 * loads". `lock2` copies `Atomics.load`/`store` into locals when it is built,
 * so the recorder has to be installed around construction; the global is
 * restored immediately afterwards and only these endpoints keep the
 * instrumented copies. `trace()` gates what is actually logged, and everything
 * here is synchronous, so no unrelated test can observe the patch.
 */
const buildTracedStealLock = (
  consumers: number,
  regionLanes: number,
  onOp?: (op: TracedOp) => void,
) => {
  const ops: TracedOp[] = [];
  let recording = false;
  const original = { load: Atomics.load, store: Atomics.store };
  let headersByteOffset = 0;
  let headersWords = 0;
  const word = (view: AtomicView, index: number): string => {
    const u32 = (view.byteOffset - headersByteOffset) / 4 + index;
    if (view.byteOffset < headersByteOffset || u32 >= headersWords) {
      return "bits";
    }
    if (u32 === liveU32) return "live";
    for (let c = 0; c < consumers; c++) {
      if (u32 === wantU32(c)) return `want${c}`;
    }
    return `word${u32}`;
  };
  const note = (op: string, view: AtomicView, index: number) => {
    if (!recording) return;
    const traced = { op, word: word(view, index) };
    ops.push(traced);
    // Fires *before* the operation completes, which is the only way a test can
    // stand in for a peer that changes state mid-handshake.
    if (onOp !== undefined) onOp(traced);
  };

  let built: ReturnType<typeof buildStealLock>;
  try {
    Atomics.load = ((view: AtomicView, index: number) => {
      note("load", view, index);
      return (original.load as unknown as (v: AtomicView, i: number) => number)(
        view,
        index,
      );
    }) as unknown as typeof Atomics.load;
    Atomics.store = ((view: AtomicView, index: number, value: number) => {
      note("store", view, index);
      return (original.store as unknown as (
        v: AtomicView,
        i: number,
        x: number,
      ) => number)(view, index, value);
    }) as unknown as typeof Atomics.store;
    built = buildStealLock(consumers, regionLanes, "dekker");
  } finally {
    Atomics.load = original.load;
    Atomics.store = original.store;
  }
  headersByteOffset = built.headers.byteOffset;
  headersWords = built.headers.length;

  return {
    ...built,
    trace: <T>(body: () => T): { result: T; ops: TracedOp[] } => {
      ops.length = 0;
      recording = true;
      try {
        return { result: body(), ops: [...ops] };
      } finally {
        recording = false;
      }
    },
  };
};

/** Endpoints that run `onDecodeAt` once per decoded lane, before the decode. */
const buildHookedStealLock = (
  consumers: number,
  regionLanes: number,
  onDecodeAt: (consumerId: number, nth: number) => void,
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
  const seen: number[] = Array.from({ length: consumers }, () => 0);
  return {
    shared,
    producer: lock2({
      ...shared,
      consumers,
      regionLanes,
      stealClaim: "dekker",
    }),
    consumers: Array.from({ length: consumers }, (_, consumerId) =>
      lock2({
        ...shared,
        consumers,
        consumerId,
        regionLanes,
        stealClaim: "dekker",
        recycleList: {
          shiftNoClear: () => {
            seen[consumerId] = seen[consumerId]! + 1;
            onDecodeAt(consumerId, seen[consumerId]!);
            return undefined;
          },
        } as never,
      })),
    headers: new Int32Array(
      headersRegion.sab,
      headersRegion.byteOffset,
      headersRegion.byteLength >>> 2,
    ),
  };
};

/** The operations a call performed before it declared any intent. */
const selectionOps = (ops: TracedOp[], self: number): TracedOp[] => {
  const declared = ops.findIndex((op) =>
    op.op === "store" && op.word === `want${self}`
  );
  return declared < 0 ? ops : ops.slice(0, declared);
};

const drainValues = (
  endpoint: {
    resolved: { toArray: () => { value: unknown }[]; clear: () => void };
  },
): unknown[] => {
  const values = endpoint.resolved.toArray().map((task) => task.value);
  endpoint.resolved.clear();
  return values;
};

const publish = (
  producer: { encode: (task: ReturnType<typeof makeTask>) => boolean },
  count: number,
  from = 0,
) => {
  for (let i = 0; i < count; i++) {
    assert.equal(
      producer.encode(makeValueTask(from + i)),
      true,
      `publish ${from + i}`,
    );
  }
};

test("a globally empty poll costs exactly the two arbitration loads", () => {
  const { consumers: endpoints, trace } = buildTracedStealLock(3, 4);
  const { result, ops } = trace(() => endpoints[1]!.decode());
  assert.equal(result, false);
  assert.deepEqual(ops, [
    { op: "load", word: "bits" },
    { op: "load", word: "bits" },
  ]);
});

test("Dekker surveys every live peer before declaring intent", () => {
  const built = buildTracedStealLock(4, 4);
  publish(built.producer, 4);
  const { result, ops } = built.trace(() => built.consumers[2]!.decode());
  assert.equal(result, true);
  assert.deepEqual(
    selectionOps(ops, 2).filter((op) => op.word.startsWith("want")),
    [0, 1, 3].map((id) => ({ op: "load", word: `want${id}` })),
  );
  assert.deepEqual(drainValues(built.consumers[2]!), [0, 1, 2, 3]);
});

test("Dekker rechecks global-ID seniors after declaring intent", () => {
  let declared = false;
  const built = buildTracedStealLock(3, 4, (op) => {
    if (declared || op.op !== "store" || op.word !== "want2") return;
    declared = true;
    // A concurrent senior declares after selection, before our post-store scan.
    Atomics.store(built.headers, wantU32(1), 1 << 7);
  });
  publish(built.producer, 4);
  const { result, ops } = built.trace(() => built.consumers[2]!.decode());
  assert.equal(result, false);
  const declaration = ops.findIndex((op) =>
    op.op === "store" && op.word === "want2"
  );
  assert.equal(declaration >= 0, true);
  assert.deepEqual(
    ops.slice(declaration + 1).filter((op) =>
      op.op === "load" && op.word.startsWith("want")
    ),
    [0, 1].map((id) => ({ op: "load", word: `want${id}` })),
  );
  assert.equal(built.consumers[2]!.resolved.isEmpty, true);
  assert.equal(Atomics.load(built.headers, wantU32(2)), 0);
});

for (const exit of ["release", "confirmed death"] as const) {
  test(`Dekker waits past empty juniors until a distant junior's ${exit}`, () => {
    let reads = 0;
    const built = buildTracedStealLock(3, 4, (op) => {
      if (op.op !== "load" || op.word !== "want2" || ++reads !== 4) return;
      assert.equal(built.consumers[0]!.resolved.isEmpty, true);
      if (exit === "release") Atomics.store(built.headers, wantU32(2), 0);
      else built.producer.deactivateStealConsumer(2);
    });
    publish(built.producer, 4);
    // Junior 1 is empty; junior 2 already holds the only pending region.
    Atomics.store(built.headers, wantU32(2), 1 << 7);
    const { result } = built.trace(() => built.consumers[0]!.decode());
    assert.equal(result, true);
    assert.equal(reads >= 4, true, "the senior actually waited");
    assert.deepEqual(drainValues(built.consumers[0]!), [0, 1, 2, 3]);
    assert.equal(Atomics.load(built.headers, wantU32(0)), 0);
    assert.equal(
      Atomics.load(built.headers, wantU32(2)),
      exit === "release" ? 0 : 1 << 7,
    );
  });
}

for (const consumerId of [0, 1]) {
  test(`a claim by consumer ${consumerId} decodes one snapshot`, () => {
    let next = 100;
    const built = buildHookedStealLock(2, 16, (id, nth) => {
      if (id !== consumerId || nth !== 1) return;
      // Region 1 still has free lanes, so this refill lands in the region the
      // claim is holding right now.
      for (let i = 0; i < 4; i++) {
        assert.equal(built.producer.encode(makeValueTask(next++)), true);
      }
    });
    publish(built.producer, 4);

    assert.equal(built.consumers[consumerId]!.decode(), true);
    assert.deepEqual(drainValues(built.consumers[consumerId]!), [0, 1, 2, 3]);
    assert.equal(built.consumers[consumerId]!.decode(), true);
    assert.deepEqual(
      drainValues(built.consumers[consumerId]!),
      [100, 101, 102, 103],
    );
  });
}

test("no new claimant enters a region while a claim is in progress", () => {
  let attempts = 0;
  const built = buildHookedStealLock(2, 16, (consumerId, nth) => {
    // Consumer 0 holds the region. Its junior must not enter mid-decode.
    if (consumerId !== 0 || nth !== 2) return;
    attempts++;
    assert.equal(built.consumers[1]!.decode(), false);
    assert.equal(built.consumers[1]!.resolved.isEmpty, true);
  });
  publish(built.producer, 4);

  assert.equal(built.consumers[0]!.decode(), true);
  assert.equal(attempts, 1, "the junior really did try mid-claim");
  assert.deepEqual(drainValues(built.consumers[0]!), [0, 1, 2, 3]);
});

test("a claim delivers binary and string payloads intact", () => {
  const { producer, consumers: endpoints } = buildStealLock(2, 16, "dekker");
  const values: unknown[] = [
    "task-0",
    new Uint8Array([1, 2, 3, 4]),
    `task-${"x".repeat(2048)}`,
    new Uint8Array([9, 8, 7]),
  ];
  for (const value of values) {
    assert.equal(producer.encode(makeValueTask(value)), true);
  }

  assert.equal(endpoints[1]!.decode(), true);
  const drained = drainValues(endpoints[1]!);
  assert.equal(drained.length, values.length);
  for (let i = 0; i < values.length; i++) {
    const expected = values[i];
    if (expected instanceof Uint8Array) {
      assert.deepEqual(
        Array.from(drained[i] as Uint8Array),
        Array.from(expected),
      );
    } else {
      assert.equal(drained[i], expected);
    }
  }
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
  const { producer, consumers } = buildStealLock(1, 8);
  assert.equal(producer.encode(makeValueTask(42)), true);
  assert.equal(consumers[0]!.decode(), true);
  assert.deepEqual(drainValues(consumers[0]!), [42]);
  assert.equal(consumers[0]!.decode(), false);
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

  // Pinned to Dekker on purpose: this asserts Dekker's recovery contract — the
  // region is released and a peer finishes the rest. Ticket deliberately does
  // the opposite (a mid-batch throw closes the queue permanently), so it must
  // not inherit this case from the default.
  const consumers = 2;
  const claim = "dekker" as const;
  const producer = lock2({ ...shared, consumers, regionLanes: 8, stealClaim: claim });
  const failing = lock2({
    ...shared,
    consumers,
    consumerId: 0,
    regionLanes: 8,
    stealClaim: claim,
    recycleList: explodingRecycle as never,
  });
  const survivor = lock2({
    ...shared,
    consumers,
    consumerId: 1,
    regionLanes: 8,
    stealClaim: claim,
  });

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
for (const claim of ["dekker", "ticket"] as const) {
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

/**
 * Sequential claims follow publication order. Concurrent consumers may finish
 * decoding or executing later claims before earlier claimants resume.
 * The region disciplines only promise order *within* a claimed region.
 */
for (const [consumers, batch] of [[2, 1], [3, 4], [4, 8], [6, 8]]) {
  test(
    `ticket sequential claims follow publication order, ${consumers} consumers, g=${batch}`,
    () => {
      const { producer, consumers: endpoints } = buildStealLock(
        consumers,
        batch,
        "ticket",
      );

      const TOTAL = 500;
      const order: number[] = [];
      let published = 0;
      let guard = 0;

      while (order.length < TOTAL) {
        if (++guard > 200_000) break;
        if (published < TOTAL && producer.encode(makeValueTask(published))) {
          published++;
          continue;
        }
        for (let c = 0; c < endpoints.length; c++) {
          const endpoint = endpoints[(guard + c) % endpoints.length]!;
          if (!endpoint.decode()) continue;
          for (const task of endpoint.resolved.toArray()) {
            order.push(task.value as number);
          }
          endpoint.resolved.clear();
        }
      }

      assert.equal(published, TOTAL, "producer published every task");
      assert.equal(order.length, TOTAL, "every task drained exactly once");
      for (let i = 0; i < TOTAL; i++) {
        assert.equal(order[i], i, `drained out of publication order at ${i}`);
      }
    },
  );
}

/** An over-claim must be impossible: the head never passes the tail. */
test("ticket never claims past the published tail", () => {
  const { producer, consumers: endpoints, headers } = buildStealLock(
    4,
    8,
    "ticket",
  );
  const headIndex = LockBound.header + STEAL_TICKET_HEAD_SLOT_OFFSET_U32;
  const tailIndex = HEADER_SLOT_STRIDE_U32 + LockBound.header +
    STEAL_TICKET_HEAD_SLOT_OFFSET_U32;

  // Drain an empty queue hard: this is the case fetch-add ticketing cannot
  // survive, and the CAS claim must leave the head untouched.
  for (let i = 0; i < 1000; i++) {
    for (const endpoint of endpoints) {
      assert.equal(endpoint.decode(), false, "claimed from an empty queue");
    }
  }
  assert.equal(Atomics.load(headers, headIndex), 0, "idle polls moved the head");
  assert.equal(Atomics.load(headers, tailIndex), 0, "idle polls moved the tail");

  for (let i = 0; i < 20; i++) assert.equal(producer.encode(makeValueTask(i)), true);
  assert.equal(Atomics.load(headers, tailIndex), 20, "tail counts publications");

  let guard = 0;
  while (Atomics.load(headers, headIndex) < 20 && guard++ < 1000) {
    for (const endpoint of endpoints) {
      endpoint.decode();
      endpoint.resolved.clear();
    }
  }
  assert.equal(Atomics.load(headers, headIndex), 20, "head reached the tail");
  for (let i = 0; i < 100; i++) {
    for (const endpoint of endpoints) {
      assert.equal(endpoint.decode(), false, "claimed past the tail");
    }
  }
  assert.equal(Atomics.load(headers, headIndex), 20, "head passed the tail");
});

const ticketWords = (headers: Int32Array) => ({
  view: new BigInt64Array(
    headers.buffer,
    headers.byteOffset,
    headers.length >>> 1,
  ),
  head: (LockBound.header + STEAL_TICKET_HEAD_SLOT_OFFSET_U32) >>> 1,
  tail: (HEADER_SLOT_STRIDE_U32 + LockBound.header +
    STEAL_TICKET_HEAD_SLOT_OFFSET_U32) >>> 1,
});
const ticketOrderIndex = (ticket: number) =>
  (ticket & 31) * HEADER_SLOT_STRIDE_U32 + LockBound.header +
  STEAL_TICKET_ORDER_SLOT_OFFSET_U32;

test("ticket crosses the 32-bit boundary without recycling its identity", () => {
  const { producer, consumers, headers } = buildStealLock(2, 8, "ticket");
  for (let i = 0; i < 3; i++) producer.encode(makeValueTask(i));
  const slots = [0, 1, 2].map((i) => headers[ticketOrderIndex(i)]!);
  // Place the same three publications across the low-word boundary.
  const start = 0xfffffffen;
  slots.forEach((slot, i) => {
    headers[ticketOrderIndex(Number((start + BigInt(i)) & 31n))] = slot;
  });
  const { view, head, tail } = ticketWords(headers);
  Atomics.store(view, head, start);
  Atomics.store(view, tail, start + 3n);
  assert.equal(consumers[0]!.decode(), true);
  assert.deepEqual(consumers[0]!.resolved.toArray().map((t) => t.value), [
    0,
    1,
    2,
  ]);
  assert.equal(Atomics.load(view, head), 0x100000001n);
  assert.equal(consumers[1]!.decode(), false);
});

test("ticket rejects a stale CAS after a full low-word cycle", () => {
  const { producer, consumers, headers } = buildStealLock(2, 1, "ticket");
  producer.encode(makeValueTask(42));
  const { view, head, tail } = ticketWords(headers);
  const original = Atomics.compareExchange;
  let intercepted = false;
  // Inject the state reached if a claimant pauses before CAS while peers
  // process 2^32 tickets and empty the queue. No wall-clock wait is needed.
  Atomics.compareExchange = ((
    array: BigInt64Array,
    index: number,
    expected: bigint,
    replacement: bigint,
  ) => {
    if (array instanceof BigInt64Array && index === head && !intercepted) {
      intercepted = true;
      Atomics.store(view, head, 1n << 32n);
      Atomics.store(view, tail, 1n << 32n);
    }
    return original(array, index, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try {
    assert.equal(consumers[0]!.decode(), false);
  } finally {
    Atomics.compareExchange = original;
  }
  assert.equal(intercepted, true);
  assert.equal(consumers[0]!.resolved.isEmpty, true);
  assert.equal(Atomics.load(view, head), 1n << 32n);
});

test("ticket decode exceptions poison the queue instead of silently losing a batch", () => {
  const { shared, producer, consumers, headers } = buildStealLock(
    2,
    8,
    "ticket",
  );
  let shifts = 0;
  const failing = lock2({
    ...shared,
    consumers: 2,
    consumerId: 0,
    regionLanes: 8,
    stealClaim: "ticket",
    recycleList: {
      shiftNoClear: () => {
        if (++shifts === 2) throw new Error("decode blew up");
        return undefined;
      },
    } as never,
  });
  for (let i = 0; i < 3; i++) producer.encode(makeValueTask(i));
  assert.throws(() => failing.decode(), /decode blew up/);
  assert.deepEqual(failing.resolved.toArray().map((t) => t.value), [0]);
  const { view, head } = ticketWords(headers);
  assert.equal(Atomics.load(view, head), STEAL_TICKET_FAILED);
  assert.equal(consumers[1]!.decode(), false);
  assert.equal(failing.decode(), false);
});

test("ticket deactivating a claimant permanently stops new claims", () => {
  const { producer, consumers, headers } = buildStealLock(2, 1, "ticket");
  producer.encode(makeValueTask(1));
  assert.equal(producer.deactivateStealConsumer(0), true);
  const { view, head } = ticketWords(headers);
  assert.equal(Atomics.load(view, head), STEAL_TICKET_FAILED);
  assert.equal(consumers[1]!.decode(), false);
  assert.equal(producer.deactivateStealConsumer(0), false);
});

test("ticket batch publication flushes earlier tickets when encoding throws", () => {
  const { producer, consumers, headers } = buildStealLock(2, 8, "ticket");
  const bad = makeValueTask(2);
  Object.defineProperty(bad, "value", {
    get: () => {
      throw new Error("encode blew up");
    },
  });
  producer.enlist(makeValueTask(1));
  producer.enlist(bad);
  assert.throws(() => producer.encodeAll(), /encode blew up/);
  const { view, tail } = ticketWords(headers);
  assert.equal(Atomics.load(view, tail), 1n);
  assert.equal(consumers[0]!.decode(), true);
  assert.deepEqual(consumers[0]!.resolved.toArray().map((t) => t.value), [1]);
});

for (const start of [(1n << 53n) - 1n, (1n << 63n) - 2n]) {
  test(`ticket preserves exact identity at ${start}`, () => {
    const { producer, consumers, headers } = buildStealLock(2, 1, "ticket");
    producer.encode(makeValueTask(99));
    headers[ticketOrderIndex(Number(start & 31n))] =
      headers[ticketOrderIndex(0)]!;
    const { view, head, tail } = ticketWords(headers);
    Atomics.store(view, head, start);
    Atomics.store(view, tail, start + 1n);
    assert.equal(consumers[0]!.decode(), true);
    assert.equal(Atomics.load(view, head), start + 1n);
    assert.deepEqual(consumers[0]!.resolved.toArray().map((t) => t.value), [
      99,
    ]);
    assert.equal(consumers[1]!.decode(), false);
  });
}

test("ticket retains the aligned slot-stride requirement", () => {
  const { shared } = buildStealLock(2, 1, "ticket");
  assert.throws(() => lock2({
    ...shared,
    consumers: 2,
    stealClaim: "ticket",
    headerSlotStrideU32: HEADER_SLOT_STRIDE_U32 + 1,
  }), /8-byte aligned slot stride/);
});

for (const count of [1, 3]) {
  test(`ticket notifier observes all ${count} published tickets`, () => {
    const { shared, consumers, headers } = buildStealLock(2, 8, "ticket");
    let notifications = 0;
    let observedTail = -1;
    const received: unknown[] = [];
    const producer = lock2({
      ...shared,
      consumers: 2,
      regionLanes: 8,
      stealClaim: "ticket",
      notifyOnHostPublish: true,
      notifyHostPublish: () => {
        notifications++;
        observedTail = Atomics.load(
          headers,
          HEADER_SLOT_STRIDE_U32 + LockBound.header +
            STEAL_TICKET_HEAD_SLOT_OFFSET_U32,
        );
        consumers[0]!.decode();
        received.push(...consumers[0]!.resolved.toArray().map((t) => t.value));
      },
    });
    Atomics.store(headers, DOORBELL_ARMED_SLOT_OFFSET_U32, 1);
    if (count === 1) producer.encode(makeValueTask(0));
    else {
      for (let i = 0; i < count; i++) producer.enlist(makeValueTask(i));
      producer.encodeAll();
    }
    assert.equal(notifications, 1);
    assert.equal(observedTail, count);
    assert.deepEqual(received, Array.from({ length: count }, (_, i) => i));
  });
}

test("ticket fails closed instead of wrapping the 64-bit claim identity", () => {
  const { producer, consumers, headers } = buildStealLock(2, 1, "ticket");
  producer.encode(makeValueTask(42));
  const { view, head, tail } = ticketWords(headers);
  Atomics.store(view, head, (1n << 63n) - 1n);
  // The 32-bit producer tail has wrapped. There is one publication beyond
  // the head's supported lifetime: fail the queue rather than repeat a head.
  Atomics.store(headers, tail * 2, 0);
  assert.throws(() => consumers[0]!.decode(), /exhausted its 64-bit sequence/);
  assert.equal(Atomics.load(view, head), STEAL_TICKET_FAILED);
  assert.equal(consumers[1]!.decode(), false);
});

for (const start of [0x7fffffffn, 0xffffffffn]) {
  test(`ticket unsigned tail distance crosses ${start}`, () => {
    const { producer, consumers, headers } = buildStealLock(2, 8, "ticket");
    producer.encode(makeValueTask(1));
    producer.encode(makeValueTask(2));
    const slots = [
      headers[ticketOrderIndex(0)]!,
      headers[ticketOrderIndex(1)]!,
    ];
    slots.forEach((slot, i) => {
      headers[ticketOrderIndex(Number((start + BigInt(i)) & 31n))] = slot;
    });
    const { view, head, tail } = ticketWords(headers);
    Atomics.store(view, head, start);
    Atomics.store(headers, tail * 2, Number((start + 2n) & 0xffffffffn));
    assert.equal(consumers[0]!.decode(), true);
    assert.equal(Atomics.load(view, head), start + 2n);
    assert.deepEqual(consumers[0]!.resolved.toArray().map((t) => t.value), [
      1,
      2,
    ]);
    assert.equal(consumers[1]!.decode(), false);
  });
}

/**
 * A silently-ignored claim setting is worse than a crash: `cas-mask` was
 * removed, and a stale config or a typo used to run Dekker under the wrong
 * name, so every benchmark built on it reported the wrong discipline.
 */
test("assertStealClaim accepts the shipped disciplines", () => {
  assert.equal(assertStealClaim("dekker", "x"), "dekker");
  assert.equal(assertStealClaim("ticket", "x"), "ticket");
});

test("assertStealClaim rejects the removed cas-mask and says so", () => {
  assert.throws(
    () => assertStealClaim("cas-mask", "KNITTING_STEAL_CLAIM"),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message.includes("KNITTING_STEAL_CLAIM") &&
      error.message.includes("cas-mask was removed"),
  );
});

test("assertStealClaim rejects typos, casing and non-strings", () => {
  for (const bad of ["Ticket", "tickett", "", "dekker ", 1, null, undefined]) {
    assert.throws(
      () => assertStealClaim(bad, "host.stealClaim"),
      RangeError,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("lock2 rejects an unknown claim discipline instead of falling back", () => {
  assert.throws(
    () =>
      buildStealLock(2, 8, "cas-mask" as unknown as StealClaimDiscipline),
    RangeError,
  );
});

test("the default claim discipline is ticket", () => {
  assert.equal(DEFAULT_STEAL_CLAIM, "ticket");
  // Observable, not just declarative: one region for four consumers is a
  // Dekker error and a non-issue for ticket, which has no regions.
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
  lock2({ ...shared, consumers: 4, regionLanes: 32 });
  assert.throws(
    () => lock2({ ...shared, consumers: 4, regionLanes: 32, stealClaim: "dekker" }),
    RangeError,
  );
});
