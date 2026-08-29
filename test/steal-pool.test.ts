import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { AbortSignalPoolExhausted } from "../src/shared/abortSignal.ts";
import { RUNTIME } from "../src/common/runtime.ts";
import { abortA, abortB, abortReturnsInput } from "./fixtures/abort_tasks.ts";
import { concat, double } from "./fixtures/steal_tasks.ts";
import { delayedEcho } from "./fixtures/loop_tasks.ts";

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

const denoFfiGranted = (): boolean => {
  if (RUNTIME !== "deno") return false;
  const deno = (globalThis as typeof globalThis & {
    Deno?: {
      permissions?: {
        querySync?: (descriptor: { name: "ffi" }) => { state?: string };
      };
    };
  }).Deno;
  try {
    return deno?.permissions?.querySync?.({ name: "ffi" }).state === "granted";
  } catch {
    return false;
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

test("stealing pool completes with the host doorbell armed immediately", async () => {
  const pool = createPool({
    threads: 2,
    host: { stallFreeLoops: 0 },
  })({ double });
  try {
    const values = await Promise.all(
      Array.from({ length: 80 }, (_, i) => pool.call.double(i)),
    );
    assert.deepEqual(values, Array.from({ length: 80 }, (_, i) => i * 2));
  } finally {
    await pool.shutdown();
  }
});

test("Deno FFI doorbell wakes a host armed before a delayed result", {
  skip: !denoFfiGranted(),
}, async () => {
  const pool = createPool({
    threads: 1,
    host: { stallFreeLoops: 0 },
  })({ delayedEcho });
  try {
    const started = performance.now();
    assert.equal(await withTimeout(pool.call.delayedEcho(50), 750), 50);
    // Without the native ring, the dispatcher reaches its 1000 ms watchdog;
    // leave broad scheduling headroom while still proving it did not do that.
    assert.ok(performance.now() - started < 750);
  } finally {
    await pool.shutdown();
  }
});

test("pool completes with the host doorbell disabled", async () => {
  const pool = createPool({
    threads: 1,
    host: { doorbell: false, stallFreeLoops: 0 },
  })({ double });
  try {
    const values = await Promise.all(
      Array.from({ length: 80 }, (_, i) => pool.call.double(i)),
    );
    assert.deepEqual(values, Array.from({ length: 80 }, (_, i) => i * 2));
  } finally {
    await pool.shutdown();
  }
});

for (const dispatcher of ["per-thread", "serial-channel"] as const) {
  test(`private-lane ${dispatcher} completes with immediate parking`, async () => {
    const pool = createPool({
      threads: 2,
      host: {
        steal: false,
        dispatcher,
        stallFreeLoops: 0,
      },
    })({ double });
    try {
      const values = await Promise.all(
        Array.from({ length: 40 }, (_, i) => pool.call.double(i)),
      );
      assert.deepEqual(values, Array.from({ length: 40 }, (_, i) => i * 2));
    } finally {
      await pool.shutdown();
    }
  });
}

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

/**
 * A stealing worker must still be able to reach its park. The claim/flush
 * reorder used under stealing once left the loop's "did this iteration move
 * anything" flag stuck true, so the park was unreachable and every worker spun
 * a core for the whole life of the pool. Idle CPU is the only thing that
 * observes it: correctness tests pass either way.
 */
test("idle stealing workers park instead of spinning", {
  timeout: 30_000,
}, async () => {
  const cpuUsage = (globalThis as typeof globalThis & {
    process?: {
      cpuUsage?: (previous?: unknown) => {
        user: number;
        system: number;
      };
    };
  }).process?.cpuUsage;
  if (typeof cpuUsage !== "function") return;

  const threads = 3;
  const idleMs = 400;
  const pool = createPool({ threads, host: { steal: true } })({ double });
  try {
    await withTimeout(
      Promise.all(Array.from({ length: 50 }, (_, i) => pool.call.double(i))),
    );

    const before = cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    const delta = cpuUsage(before);
    const busyRatio = (delta.user + delta.system) / 1000 / idleMs;

    // Parked (park-poll only) measures ~0.6 across runtimes; one spinning
    // worker per thread measures ~`threads`. Anything at or above 1 core of
    // steady burn while the pool has nothing to do is the regression.
    assert.ok(
      busyRatio < 1.5,
      `idle stealing pool burned ${
        busyRatio.toFixed(2)
      } cores over ${idleMs}ms ` +
        `with ${threads} idle workers; workers are spinning instead of parking`,
    );
  } finally {
    await pool.shutdown();
  }
});

/**
 * A shut-down pool must not leave its workers running.
 *
 * `terminate()` cannot be trusted on its own: on Deno it resolves while a
 * worker sitting in its synchronous dispatch loop keeps running, so every
 * closed pool used to leak a spinning thread and the process crept up a core at
 * a time. Shutdown therefore asks workers to leave the loop before killing
 * them. Only idle CPU observes this — every functional test passes either way,
 * which is exactly how it went unnoticed.
 */
test("shutting a pool down stops its workers", {
  timeout: 30_000,
}, async () => {
  const cpuUsage = (globalThis as typeof globalThis & {
    process?: {
      cpuUsage?: (previous?: unknown) => { user: number; system: number };
    };
  }).process?.cpuUsage;
  if (typeof cpuUsage !== "function") return;

  const rounds = 4;
  const threads = 3;
  for (let round = 0; round < rounds; round++) {
    const pool = createPool({ threads, host: { steal: true } })({ double });
    await withTimeout(
      Promise.all(Array.from({ length: 20 }, (_, i) => pool.call.double(i))),
    );
    await pool.shutdown();
  }

  // Every pool is gone, so nothing should be burning CPU. Abandoned workers
  // accumulate across rounds: these twelve measured ~1.4 cores before the fix
  // and ~0.03 after, so the threshold sits well clear of both.
  const idleMs = 300;
  const before = cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, idleMs));
  const delta = cpuUsage(before);
  const busyRatio = (delta.user + delta.system) / 1000 / idleMs;

  assert.ok(
    busyRatio < 0.4,
    `${rounds * threads} workers from shut-down pools burned ${
      busyRatio.toFixed(2)
    } cores; shutdown left them running`,
  );
});
