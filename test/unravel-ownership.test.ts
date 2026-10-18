import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createUnravelOwnership, UNRAVEL_OWNERSHIP_STRIDE } from "../src/worker/unravel-ownership.ts";
import { scrubWorkerDataSensitiveBuffers } from "../src/worker/safety/worker-data.ts";
import type { WorkerData } from "../src/types.ts";

test("peer ownership snapshots include other workers and retire completed work", () => {
  const buffer = new SharedArrayBuffer(3 * UNRAVEL_OWNERSHIP_STRIDE * 4);
  const workers = [0, 1, 2].map((id) => createUnravelOwnership(buffer, id));
  workers[0]!.publish(10);
  workers[1]!.publish(10);
  workers[2]!.publish(10);
  assert.equal(workers[0]!.total(), 30);
  workers[1]!.publish(0);
  assert.equal(workers[2]!.total(), 20);
  assert.equal(new Int32Array(buffer)[1], 0, "padding is not protocol state");
  assert.throws(() => createUnravelOwnership(buffer, 3), RangeError);
  assert.throws(() => createUnravelOwnership(new SharedArrayBuffer(4), 0), RangeError);
});

test("ownership boot buffers are removed from exposed workerData", () => {
  const counts = new SharedArrayBuffer(64);
  const data = { steal: { awaitingCounts: counts } } as unknown as WorkerData;
  const captured = data.steal;
  scrubWorkerDataSensitiveBuffers(data);
  assert.equal(data.steal, undefined);
  assert.equal(captured?.awaitingCounts, counts, "the loop keeps its captured boot wiring");
});
