import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { AbortSignalPoolExhausted } from "../src/shared/abortSignal.ts";
import {
  abortA,
  abortB,
  abortC,
  abortReturnsInput,
} from "./fixtures/abort_tasks.ts";

const withTimeout = async <T>(
  promise: Promise<T>,
  ms = 5_000,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`test timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

test("task API abortSignal tasks reject when pool shuts down", async () => {
  const { call, shutdown } = createPool({ threads: 1 })({
    abortA,
    abortB,
    abortC,
  });

  const pending = [
    call.abortA(),
    call.abortB(),
    call.abortC(),
  ];
  const settledPromise = Promise.allSettled(pending);
  await shutdown();

  const settled = await settledPromise;
  assert.equal(settled.length, 3);
  assert.equal(
    settled.every((entry) => entry.status === "rejected"),
    true,
  );

  for (const entry of settled) {
    if (entry.status !== "rejected") continue;
    assert.equal(String(entry.reason), "Thread closed");
  }
});

test("task API abortSignalCapacity bounds concurrent abort-aware calls", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    abortSignalCapacity: 2,
  })({
    abortA,
    abortB,
  });

  const pending = [
    call.abortA(),
    call.abortB(),
  ];

  await assert.rejects(
    call.abortA(),
    (reason) => reason === AbortSignalPoolExhausted,
  );

  await shutdown();
  const settled = await Promise.allSettled(pending);
  assert.equal(
    settled.every((entry) => entry.status === "rejected"),
    true,
  );
});

test("task API empty reject aborts without swallowing worker result", async () => {
  const { call, shutdown } = createPool({ threads: 1 })({
    abortReturnsInput,
  });

  try {
    const pending = call.abortReturnsInput("worker-result");
    pending.reject();

    assert.equal(await withTimeout(pending), "worker-result");
  } finally {
    await shutdown();
  }
});

test("task API default abortSignalCapacity starts at 258", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
  })({
    abortA,
  });

  const pending = Array.from({ length: 258 }, () => call.abortA());

  await assert.rejects(
    call.abortA(),
    (reason) => reason === AbortSignalPoolExhausted,
  );

  await shutdown();
  const settled = await Promise.allSettled(pending);
  assert.equal(
    settled.every((entry) => entry.status === "rejected"),
    true,
  );
});
