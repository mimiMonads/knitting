import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createLockControlCarpet } from "../src/memory/byte-carpet.ts";
import {
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  makeTask,
} from "../src/memory/lock.ts";
// Side-effect import: registers the payload codec before any lock2() call.
import "../src/memory/payloadCodec.ts";

/**
 * Regression: dynamic payloads recycled through a pressured arena.
 *
 * `free()` has two callers — the encode-side rollback
 * (`failDynamicWriteAfterReserve`) and the decode-side release
 * (`freeTaskSlot`). Each used to hold a private `workerLast` shadow and
 * blind-store the whole acknowledgement word, so one silently overwrote the
 * other's toggles. The allocator then reused a region that was still live and
 * delivered aliased payloads.
 *
 * Both halves of the fix are load-bearing:
 *  - `free()` is a single `Atomics.xor`, so concurrent toggles cannot be lost.
 *  - the arena reset fires when every tracked slot is free, not only when all
 *    32 bits are, which the blind-store race used to reach by accident.
 */
const PAYLOAD_CHARS = 2048;
const ARENA_BYTES = 1 << 16;

const runArena = (total: number, consumers: number, regionLanes: number) => {
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
    payload: new SharedArrayBuffer(ARENA_BYTES),
    payloadSector: controlLayout.lock.payloadSector,
  };
  const steal = consumers > 1;
  const producer = steal
    ? lock2({ ...shared, consumers, regionLanes })
    : lock2({ ...shared });
  const endpoints = Array.from({ length: consumers }, (_, consumerId) =>
    steal
      ? lock2({ ...shared, consumers, consumerId, regionLanes })
      : lock2({ ...shared }));

  // Raw lock2 instances have no owner to settle deferred payloads; these values
  // are all plain strings, so a no-op keeps the codec from calling into an
  // unset handler.
  const noop = () => {};
  producer.setPromiseHandler(noop);
  for (const endpoint of endpoints) endpoint.setPromiseHandler(noop);

  const makeValueTask = (value: number) => {
    const task = makeTask();
    task.value = "x".repeat(PAYLOAD_CHARS) + value;
    return task;
  };

  const seen = new Set<number>();
  let published = 0;
  let drained = 0;
  let duplicates = 0;

  for (let guard = 0; guard < 200_000 && drained < total; guard++) {
    if (published < total && producer.encode(makeValueTask(published))) {
      published++;
      continue;
    }
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[(guard + i) % endpoints.length]!;
      if (!endpoint.decode()) continue;
      const taken = endpoint.resolved.toArray();
      endpoint.resolved.clear();
      for (const task of taken) {
        const value = Number(String(task.value).slice(PAYLOAD_CHARS));
        if (seen.has(value)) duplicates++;
        else seen.add(value);
        drained++;
      }
    }
  }

  return { published, drained, duplicates, unique: seen.size };
};

// 80 tasks fit without recycling; 400 forces the arena to be reused repeatedly,
// which is where the aliasing used to appear.
for (const total of [80, 400]) {
  test(`single consumer recycles a pressured payload arena (${total} tasks)`, () => {
    const result = runArena(total, 1, 8);
    assert.equal(result.published, total, "producer did not drain the arena");
    assert.equal(result.drained, total);
    assert.equal(result.duplicates, 0, "payload region was aliased");
    assert.equal(result.unique, total, "payloads were lost");
  });
}

for (const [consumers, regionLanes] of [[2, 8], [3, 8], [4, 4]]) {
  test(
    `stealing recycles a pressured payload arena (${consumers} consumers, g=${regionLanes})`,
    () => {
      const result = runArena(400, consumers, regionLanes);
      assert.equal(result.published, 400, "producer did not drain the arena");
      assert.equal(result.drained, 400);
      assert.equal(result.duplicates, 0, "payload region was aliased");
      assert.equal(result.unique, 400, "payloads were lost");
    },
  );
}
