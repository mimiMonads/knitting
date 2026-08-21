import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { AbortSignalPoolExhausted } from "../src/shared/abortSignal.ts";
import { abortA, abortB, abortReturnsInput } from "./fixtures/abort_tasks.ts";
import { concat, double } from "./fixtures/steal_tasks.ts";

const withTimeout = async <T>(promise: Promise<T>, ms = 5_000): Promise<T> => {
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

/**
 * End-to-end cover for the default shared-submit transport through the public
 * API: one shared submit region, private return lanes, and a pool-global
 * registry, so a response may come back from whichever worker claimed it.
 */
test("multi-worker thread pools steal by default", async () => {
  const pool = createPool({ threads: 4 })({
    double,
    concat,
  });
  try {
    const numbers = await Promise.all(
      Array.from({ length: 300 }, (_, i) => pool.call.double(i)),
    );
    for (let i = 0; i < numbers.length; i++) assert.equal(numbers[i], i * 2);

    // Interleave a second task id so responses cannot be matched by shape.
    const mixed = await Promise.all(
      Array.from(
        { length: 100 },
        (_, i) => i % 2 === 0 ? pool.call.double(i) : pool.call.concat(`v${i}`),
      ),
    );
    for (let i = 0; i < mixed.length; i++) {
      assert.equal(mixed[i], i % 2 === 0 ? i * 2 : `v${i}!`);
    }
  } finally {
    await pool.shutdown();
  }
});

test("stealing pool handles a payload large enough to need the arena", async () => {
  const pool = createPool({ threads: 3 })({ concat });
  try {
    const big = "x".repeat(4096);
    const out = await Promise.all(
      Array.from({ length: 120 }, (_, i) => pool.call.concat(`${big}${i}`)),
    );
    for (let i = 0; i < out.length; i++) assert.equal(out[i], `${big}${i}!`);
  } finally {
    await pool.shutdown();
  }
});

test("stealing pool shares abort signals across every claimant", async () => {
  const pool = createPool({ threads: 3 })({
    abortReturnsInput,
  });
  try {
    const pending = pool.call.abortReturnsInput("worker-result");
    pending.reject();
    assert.equal(await withTimeout(pending), "worker-result");
  } finally {
    await pool.shutdown();
  }
});

test("stealing pool enforces one pool-global abort capacity", async () => {
  const pool = createPool({
    threads: 2,
    abortSignalCapacity: 2,
  })({ abortA, abortB });

  const pending = [pool.call.abortA(), pool.call.abortB()];
  try {
    await assert.rejects(
      pool.call.abortA(),
      (reason) => reason === AbortSignalPoolExhausted,
    );
  } finally {
    await pool.shutdown();
  }

  const settled = await Promise.allSettled(pending);
  assert.equal(settled.every((entry) => entry.status === "rejected"), true);
});

test("stealing rejects process workers before spawning them", () => {
  assert.throws(
    () =>
      createPool({
        threads: 2,
        host: { steal: true },
        worker: { runtime: "process", processRuntime: "bun" },
      })({ double }),
    /host\.steal does not support process workers/,
  );
});

test("default and explicit scheduling choices select the intended topology", async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    messages.push(values.map(String).join(" "));
  };

  try {
    const defaultPool = createPool({
      threads: 2,
      debug: { host: true },
    })({ double });
    try {
      assert.equal(await defaultPool.call.double(21), 42);
    } finally {
      await defaultPool.shutdown();
    }
    assert.equal(
      messages.some((message) => message.includes("dispatcher=steal")),
      true,
    );
    messages.length = 0;

    for (
      const options of [
        { threads: 1, debug: { host: true } },
        { threads: 2, debug: { host: true }, host: { steal: false } },
        { threads: 2, debug: { host: true }, balancer: "firstIdle" },
        {
          threads: 2,
          debug: { host: true },
          host: { dispatcher: "per-thread" },
        },
      ] as const
    ) {
      const pool = createPool(options)({ double });
      try {
        assert.equal(await pool.call.double(21), 42);
      } finally {
        await pool.shutdown();
      }
    }
  } finally {
    console.error = originalError;
  }

  assert.equal(
    messages.some((message) => message.includes("dispatcher=steal")),
    false,
  );
});
