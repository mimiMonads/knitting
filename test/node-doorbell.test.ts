import assert from "node:assert/strict";
import test from "./_runner.ts";
import { RUNTIME } from "../src/common/runtime.ts";
import { RUNTIME_WORKER } from "../src/common/worker-runtime.ts";
import { createNodeCompletionDoorbell } from "../src/runtime/node-doorbell.ts";

const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), 500)
    ),
  ]);

test("Node uv_async completion doorbell wakes an idle host from a worker", {
  skip: RUNTIME !== "node",
}, async () => {
  let wake!: () => void;
  const woke = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const doorbell = createNodeCompletionDoorbell(wake);
  assert.ok(doorbell, "Node native doorbell addon should be available");

  const workerUrl = new URL("./fixtures/node-doorbell-worker.ts", import.meta.url);
  const Worker = RUNTIME_WORKER;
  assert.equal(typeof Worker, "function");
  const worker = new Worker!(workerUrl, {
    type: "module",
    workerData: { pointer: String(doorbell.pointer) },
  });
  try {
    await withTimeout(woke, "Node uv_async doorbell");
  } finally {
    await Promise.resolve(worker.terminate());
    doorbell.close();
  }
});
