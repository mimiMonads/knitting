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

test("explicit balancers do not change shared-submit stealing", async () => {
  const pool = createPool({
    threads: 3,
    balancer: "firstIdle",
    host: { steal: true },
  })({ double });
  try {
    const values = await Promise.all(
      Array.from({ length: 120 }, (_, i) => pool.call.double(i)),
    );
    assert.deepEqual(values, Array.from({ length: 120 }, (_, i) => i * 2));
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

for (const topology of ["steal", "per-thread", "serial-channel"] as const) {
  test(`${topology} wakes repeatedly after idle periods and send bursts`, async () => {
    const pool = createPool({
      threads: 2,
      host: topology === "steal"
        ? { steal: true, stallFreeLoops: 0 }
        : { steal: false, dispatcher: topology, stallFreeLoops: 0 },
      // Use a long park timeout so a lost wake cannot hide.
      worker: { timers: { spinMicroseconds: 0, parkMs: 60_000 } },
    })({ double });
    try {
      for (let turn = 0; turn < 24; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const size = turn % 2 === 0 ? 1 : 128;
        const values = await withTimeout(Promise.all(
          Array.from({ length: size }, (_, i) => pool.call.double(turn + i)),
        ));
        assert.deepEqual(
          values,
          Array.from({ length: size }, (_, i) => (turn + i) * 2),
        );
      }
    } finally {
      await pool.shutdown();
    }
  });
}

test("ticket worker failure rejects pending calls and permanently closes submissions", async () => {
  const { crashTicketWorker } = await import(
    "./fixtures/ticket_failure_tasks.ts"
  );
  const pool = createPool({
    threads: 2,
    host: { steal: true, stealClaim: "ticket", stealRegionLanes: 1 },
  })({ double, delayedEcho, crashTicketWorker });
  try {
    assert.equal(await withTimeout(pool.call.double(2)), 4);
    const results = await withTimeout(Promise.allSettled([
      pool.call.crashTicketWorker(),
      ...Array.from({ length: 8 }, () => pool.call.delayedEcho(200)),
    ]));
    assert.equal(results[0]!.status, "rejected");
    assert.ok(results.every((r) => r.status === "rejected"));
    const later = await withTimeout(Promise.allSettled(
      Array.from({ length: 40 }, (_, i) => pool.call.double(i)),
    ));
    assert.ok(
      later.every((r) => r.status === "rejected"),
      "calls routed through surviving workers must also reject",
    );
  } finally {
    await withTimeout(pool.shutdown());
  }
});

test("ticket ordinary task rejection leaves the pool usable", async () => {
  const { rejectTicketTask } = await import(
    "./fixtures/ticket_failure_tasks.ts"
  );
  const pool = createPool({
    threads: 2,
    host: { steal: true, stealClaim: "ticket" },
  })({ double, rejectTicketTask });
  try {
    const [outcome] = await withTimeout(
      Promise.allSettled([pool.call.rejectTicketTask()]),
    );
    assert.equal(outcome!.status, "rejected");
    assert.equal(await withTimeout(pool.call.double(7)), 14);
  } finally {
    await withTimeout(pool.shutdown());
  }
});

test("ticket publication releases large payloads across repeated concurrent slot reuse", async () => {
  const pool = createPool({
    threads: 4,
    host: { steal: true, stealClaim: "ticket", stealRegionLanes: 1 },
  })({ double, concat });
  try {
    const inputs = Array.from(
      { length: 1200 },
      (_, i) => `${i}:` + "x".repeat(4096),
    );
    const results = await withTimeout(
      Promise.all(inputs.map((value) => pool.call.concat(value))),
    );
    assert.deepEqual(results, inputs.map((value) => `${value}!`));
    const numbers = await withTimeout(Promise.all(
      Array.from({ length: 1200 }, (_, i) => pool.call.double(i)),
    ));
    assert.deepEqual(numbers, Array.from({ length: 1200 }, (_, i) => i * 2));
  } finally {
    await withTimeout(pool.shutdown());
  }
});

/**
 * Configuration that no longer exists must fail loudly. `cas-mask` was removed,
 * and silently resolving it to Dekker would let a stale deployment or a typo
 * run a discipline nobody selected.
 */
test("KNITTING_STEAL_CLAIM rejects a removed discipline", () => {
  const previous = process.env.KNITTING_STEAL_CLAIM;
  process.env.KNITTING_STEAL_CLAIM = "cas-mask";
  try {
    assert.throws(
      () => createPool({ threads: 2, host: { steal: true } })({ double }),
      (error: unknown) =>
        error instanceof RangeError &&
        error.message.includes("KNITTING_STEAL_CLAIM") &&
        error.message.includes("cas-mask was removed"),
    );
  } finally {
    if (previous === undefined) delete process.env.KNITTING_STEAL_CLAIM;
    else process.env.KNITTING_STEAL_CLAIM = previous;
  }
});

test("KNITTING_STEAL_CLAIM rejects a typo", () => {
  const previous = process.env.KNITTING_STEAL_CLAIM;
  process.env.KNITTING_STEAL_CLAIM = "tickett";
  try {
    assert.throws(
      () => createPool({ threads: 2, host: { steal: true } })({ double }),
      RangeError,
    );
  } finally {
    if (previous === undefined) delete process.env.KNITTING_STEAL_CLAIM;
    else process.env.KNITTING_STEAL_CLAIM = previous;
  }
});

test("an unknown host.stealClaim is rejected", () => {
  assert.throws(
    () =>
      createPool({
        threads: 2,
        host: { steal: true, stealClaim: "cas-mask" as never },
      })({ double }),
    (error: unknown) =>
      error instanceof RangeError && error.message.includes("host.stealClaim"),
  );
});

test("dekker stays explicitly selectable", async () => {
  const pool = createPool({
    threads: 2,
    host: { steal: true, stealClaim: "dekker" },
  })({ double });
  try {
    const out = await withTimeout(
      Promise.all(Array.from({ length: 16 }, (_, i) => pool.call.double(i))),
    );
    assert.deepEqual(out, Array.from({ length: 16 }, (_, i) => i * 2));
  } finally {
    await pool.shutdown();
  }
});

/**
 * Exercise the explicitly selected Dekker path under real backlog and worker
 * contention. Mixed task ids keep responses from being matched by shape, and
 * string payloads exercise the arena rather than only the header word.
 */
for (const threads of [2, 4]) {
  test(`dekker drains a saturated pool with ${threads} workers`, async () => {
    const pool = createPool({
      threads,
      host: { steal: true, stealClaim: "dekker" },
    })({ double, concat });
    try {
      const TOTAL = 400;
      const numbers = Array.from(
        { length: TOTAL },
        (_, i) => pool.call.double(i),
      );
      const strings = Array.from(
        { length: TOTAL },
        (_, i) => pool.call.concat(`v${i}`),
      );
      const [doubled, joined] = await withTimeout(
        Promise.all([Promise.all(numbers), Promise.all(strings)]),
        20_000,
      );
      assert.deepEqual(doubled, Array.from({ length: TOTAL }, (_, i) => i * 2));
      assert.deepEqual(joined, Array.from({ length: TOTAL }, (_, i) => `v${i}!`));
    } finally {
      await pool.shutdown();
    }
  });
}

test("a stealing pool with no claim selected runs on the ticket default", async () => {
  const previous = process.env.KNITTING_STEAL_CLAIM;
  delete process.env.KNITTING_STEAL_CLAIM;
  // 32 lanes leaves a single region, which Dekker rejects for two consumers and
  // ticket does not care about — so this only builds under the ticket default.
  const pool = createPool({
    threads: 2,
    host: { steal: true, stealRegionLanes: 32 },
  })({ double });
  try {
    const out = await withTimeout(
      Promise.all(Array.from({ length: 16 }, (_, i) => pool.call.double(i))),
    );
    assert.deepEqual(out, Array.from({ length: 16 }, (_, i) => i * 2));
  } finally {
    await pool.shutdown();
    if (previous !== undefined) process.env.KNITTING_STEAL_CLAIM = previous;
  }
});
