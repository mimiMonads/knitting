import assert from "node:assert/strict";
import test from "./_runner.ts";
import { RUNTIME } from "../src/common/runtime.ts";
import { RUNTIME_WORKER } from "../src/common/worker-runtime.ts";
import { createNodeCompletionDoorbell } from "../src/runtime/node-doorbell.ts";

// The wait includes spawning the worker and stripping its imports, which takes
// well over 500ms while the suite runs other files in parallel. A doorbell that
// never rings still times out.
const withTimeout = async <T>(
  promise: Promise<T>,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test("Node uv_async completion doorbell wakes an idle host from a worker", {
  skip: RUNTIME !== "node",
}, async () => {
  let wake!: () => void;
  const woke = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const doorbell = createNodeCompletionDoorbell(wake);
  assert.ok(doorbell, "Node native doorbell addon should be available");

  const workerUrl = new URL(
    "./fixtures/node-doorbell-worker.ts",
    import.meta.url,
  );
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
