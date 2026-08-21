import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createLockControlCarpet } from "../src/memory/byte-carpet.ts";
import {
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  TaskIndex,
} from "../src/memory/lock.ts";
import "../src/memory/payloadCodec.ts";
import { createHostTxQueue } from "../src/runtime/tx-queue.ts";

/**
 * End-to-end shape of the stealing transport, driven in-process.
 *
 *   host --[ one shared submit lock, N stealing consumers ]--> workers
 *   host <--[ N private return locks, one per worker ]--------- workers
 *
 * The host keeps a single pool-global pending registry; task IDs index it, so a
 * response may arrive on any lane and still settle the right promise. That is
 * the "stealer owns the response" property.
 */
const buildStealingPool = (workers: number, regionLanes: number) => {
  const carpet = () =>
    createLockControlCarpet({
      signalBytes: 0,
      abortBytes: 0,
      lockSectorBytes: LOCK_SECTOR_BYTE_LENGTH,
      headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
      slotCount: LockBound.slots,
      headerLayout: "split",
    });

  // One shared submit region every worker can claim from.
  const submitLayout = carpet();
  const submitShared = {
    LockBoundSector: submitLayout.lock.lockSector,
    headers: submitLayout.lock.headers,
    payload: new SharedArrayBuffer(1 << 18),
    payloadSector: submitLayout.lock.payloadSector,
  };
  const hostSubmit = lock2({
    ...submitShared,
    consumers: workers,
    regionLanes,
  });
  const workerSubmit = Array.from(
    { length: workers },
    (_, consumerId) =>
      lock2({ ...submitShared, consumers: workers, consumerId, regionLanes }),
  );

  // One private return region per worker.
  const returnLayouts = Array.from({ length: workers }, carpet);
  const returnShared = returnLayouts.map((layout) => ({
    LockBoundSector: layout.returnLock.lockSector,
    headers: layout.returnLock.headers,
    payload: new SharedArrayBuffer(1 << 18),
    payloadSector: layout.returnLock.payloadSector,
  }));
  const hostReturns = returnShared.map((shared) => lock2({ ...shared }));
  const workerReturns = returnShared.map((shared) => lock2({ ...shared }));

  const noop = () => {};
  for (
    const lock of [
      hostSubmit,
      ...workerSubmit,
      ...hostReturns,
      ...workerReturns,
    ]
  ) {
    lock.setPromiseHandler(noop);
  }

  const queue = createHostTxQueue({
    lock: hostSubmit,
    returnLock: hostReturns[0]!,
    extraReturnLocks: hostReturns.slice(1),
  });

  // A worker claims whatever it can from the shared region, "runs" the task,
  // and publishes the result on its own return lane. `stalled` models an
  // endpoint that has stopped pulling.
  const stalled = new Set<number>();
  const runWorker = (id: number) => {
    if (stalled.has(id)) return 0;
    const submit = workerSubmit[id]!;
    const back = workerReturns[id]!;
    if (!submit.decode()) return 0;
    const taken = submit.resolved.toArray();
    submit.resolved.clear();
    for (const task of taken) {
      task.value = `handled:${task.value}:by${id}`;
      // FlagsToHost shares its word with FunctionID on the request path; the
      // real worker rewrites it before replying, so a leftover function id is
      // not read back as TaskFlag.Reject.
      task[TaskIndex.FlagsToHost] = 0;
      back.encode(task);
    }
    return taken.length;
  };

  return { queue, runWorker, stalled };
};

for (const [workers, regionLanes] of [[2, 8], [3, 8], [4, 4]]) {
  test(
    `shared submit + per-lane returns settle by task id (${workers} workers, g=${regionLanes})`,
    async () => {
      const { queue, runWorker } = buildStealingPool(workers, regionLanes);
      const TOTAL = 300;

      const pending: Promise<unknown>[] = [];
      const enqueue = queue.enqueue(1);
      for (let i = 0; i < TOTAL; i++) {
        pending.push(enqueue(`task${i}` as never));
      }

      let guard = 0;
      let settled = 0;
      while (settled < TOTAL && guard++ < 200_000) {
        while (queue.hasPendingFrames()) {
          if (!queue.flushToWorker()) break;
        }
        for (let id = 0; id < workers; id++) runWorker(id);
        settled += queue.completeFrame();
      }

      assert.equal(settled, TOTAL, "every task settled");
      const values = await Promise.all(pending);
      const handlers = new Set<string>();
      for (let i = 0; i < TOTAL; i++) {
        const value = String(values[i]);
        assert.match(
          value,
          new RegExp(`^handled:task${i}:by\\d+$`),
          `task ${i} settled with the wrong response (${value})`,
        );
        handlers.add(value.slice(value.lastIndexOf(":by")));
      }
      assert.equal(queue.txIdle(), true, "queue drained");
      // Not a fairness assertion — just proof the work really did spread.
      assert.equal(handlers.size > 1, true, "only one worker ever claimed");
    },
  );
}

// Fixed priority makes juniors withdraw for seniors, so the question is whether
// an endpoint that simply stops pulling can wedge the pool. It cannot: priority
// only defers to a senior that is actually holding intent, not to an idle one.
// A worker halted mid-claim is covered in lock-steal.test.ts: the host-owned
// liveness mask makes its stale intent ineligible after confirmed termination.
for (
  const [workers, regionLanes, stall] of [
    [4, 4, [0]],
    [4, 4, [0, 1]],
    [3, 8, [0, 1]], // only the most-junior endpoint left alive
  ] as const
) {
  test(
    `stalled endpoints [${stall.join(",")}] do not wedge ${workers} workers`,
    async () => {
      const { queue, runWorker, stalled } = buildStealingPool(
        workers,
        regionLanes,
      );
      for (const id of stall) stalled.add(id);

      const TOTAL = 200;
      const pending: Promise<unknown>[] = [];
      const enqueue = queue.enqueue(1);
      for (let i = 0; i < TOTAL; i++) {
        pending.push(enqueue(`task${i}` as never));
      }

      let settled = 0;
      let guard = 0;
      while (settled < TOTAL && guard++ < 200_000) {
        while (queue.hasPendingFrames()) {
          if (!queue.flushToWorker()) break;
        }
        for (let id = 0; id < workers; id++) runWorker(id);
        settled += queue.completeFrame();
      }

      assert.equal(settled, TOTAL, "stalled endpoint blocked the drain");
      const values = await Promise.all(pending);
      for (const id of stall) {
        for (const value of values) {
          assert.notEqual(
            String(value).endsWith(`:by${id}`),
            true,
            `stalled worker ${id} claimed work`,
          );
        }
      }
      assert.equal(queue.txIdle(), true, "queue drained");
    },
  );
}
