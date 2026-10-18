import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess, { spawnSync } from "node:child_process";
import test from "./_runner.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createPool } from "../knitting.ts";
import {
  PROCESS_WORKER_ASYNC_ACTIVE,
  PROCESS_WORKER_ASYNC_IDLE,
} from "../src/common/worker-runtime.ts";
import { loadNodeFutexAddon, loadNodeSharedMemoryAddon } from "../src/connections/node.ts";
import {
  addOnePromise,
  reportIsMain,
  returnSharedArrayBuffer,
} from "./fixtures/runtime_tasks.ts";
import { spawnChildProcess } from "./fixtures/permission_tasks.ts";
import { concat, double } from "./fixtures/steal_tasks.ts";
import {
  disconnectDuringAsyncPark,
  holdForAsyncPark,
  occupyAsyncCapacity,
  awaitWithMarker,
  markAsyncClaim,
  readAsyncParkPolls,
  rejectAfterAsyncPark,
} from "./fixtures/process_async_park_tasks.ts";
import { abortReturnsInput } from "./fixtures/abort_tasks.ts";

const PROMISE_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = PROMISE_TIMEOUT_MS * 6;
const versions = (globalThis as typeof globalThis & {
  process?: {
    platform?: string;
    versions?: { bun?: string; node?: string };
  };
  Deno?: unknown;
}).process?.versions;
const runtimePlatform = (globalThis as typeof globalThis & {
  process?: { platform?: string };
}).process?.platform;
const isPlainNode = typeof versions?.node === "string" &&
  versions.bun === undefined &&
  (globalThis as typeof globalThis & { Deno?: unknown }).Deno === undefined;
const isBunMacOS = runtimePlatform === "darwin" &&
  typeof versions?.bun === "string";
// See process-shared-buffer.test.ts: Bun/macOS cannot reopen shm names via FFI.
const bunMacOSNamedSharedMemorySkip = isBunMacOS
  ? "skipping named shared memory on Bun/macOS while shm_open reopen is investigated"
  : false;
const processRuntimeTestSkip = isPlainNode && runtimePlatform === "win32"
  ? "skipping process runtime tests on Node Windows while the CI hang is investigated"
  : false;
let nodeSharedMemoryAddonIsAvailable: boolean | undefined;
let nodeCommandSharedMemoryAddonIsAvailable: boolean | undefined;

const withTimeout = async <T>(
  label: string,
  promise: Promise<T>,
  ms = PROMISE_TIMEOUT_MS,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const shutdownWithTimeout = async (
  label: string,
  shutdown: Promise<void>,
  priorError?: unknown,
): Promise<void> => {
  try {
    await withTimeout(label, shutdown);
  } catch (shutdownError) {
    if (priorError !== undefined) {
      throw new AggregateError(
        [priorError, shutdownError],
        `${errorMessage(priorError)}; ${errorMessage(shutdownError)}`,
      );
    }
    throw shutdownError;
  }
};

const hasCommand = (command: string): boolean => {
  try {
    const args = command === "env" ? [] : ["--version"];
    return spawnSync(command, args, {
      stdio: "ignore",
      timeout: PROMISE_TIMEOUT_MS,
    }).status === 0;
  } catch {
    return false;
  }
};

const hasNodeSharedMemoryAddon = (): boolean => {
  nodeSharedMemoryAddonIsAvailable ??= (() => {
    try {
      loadNodeSharedMemoryAddon();
      return true;
    } catch {
      return false;
    }
  })();
  return nodeSharedMemoryAddonIsAvailable;
};

const hasNodeCommandSharedMemoryAddon = (): boolean => {
  nodeCommandSharedMemoryAddonIsAvailable ??= (() => {
    const probe = spawnSync(
      "node",
      [
        "--no-warnings",
        "--experimental-transform-types",
        "--input-type=module",
        "--eval",
        'const { loadNodeSharedMemoryAddon } = await import("./src/connections/node.ts"); loadNodeSharedMemoryAddon();',
      ],
      {
        cwd: process.cwd(),
        stdio: "ignore",
        timeout: PROMISE_TIMEOUT_MS,
      },
    );
    return probe.status === 0;
  })();
  return nodeCommandSharedMemoryAddonIsAvailable;
};

const hasProcessRuntime = (command: "bun" | "deno" | "node"): boolean => {
  if (isPlainNode && !hasNodeSharedMemoryAddon()) return false;
  if (!hasCommand(command)) return false;
  if (
    command === "node" && !isPlainNode && !hasNodeCommandSharedMemoryAddon()
  ) {
    return false;
  }
  return true;
};

const runProcessWorkerSmoke = async (
  processRuntime: "bun" | "deno" | "node",
  worker?: {
    processCommandPrefix?: string[];
    processSharedMemory?: "inherit" | "named" | {
      mode?: "inherit" | "named";
      namePrefix?: string;
      unlinkOnShutdown?: boolean;
    };
  },
  threads = 1,
): Promise<void> => {
  const labels = [`${processRuntime} process worker`];
  if (worker?.processCommandPrefix !== undefined) labels.push("command prefix");
  if (worker?.processSharedMemory !== undefined) labels.push("named shm");
  const workerLabel = labels.join(" with ");
  const pool = createPool({
    threads,
    worker: {
      runtime: "process",
      processRuntime,
      ...worker,
    },
    payload: {
      payloadMaxByteLength: 1024 * 1024,
    },
  })({
    addOnePromise,
    reportIsMain,
  });

  let testError: unknown;
  try {
    const [value, workerIsMain] = await Promise.all([
      withTimeout(
        `${workerLabel} addOnePromise`,
        pool.call.addOnePromise(41),
      ),
      withTimeout(
        `${workerLabel} reportIsMain`,
        pool.call.reportIsMain(),
      ),
    ]);

    assert.equal(value, 42);
    assert.equal(workerIsMain, false);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      `${workerLabel} shutdown`,
      pool.shutdown(),
      testError,
    );
  }
};

test("process worker diagnostics harness is alive", {
  skip: processRuntimeTestSkip,
}, () => {
  assert.equal(true, true);
});

test(
  "process workers fail before spawn for explicit unsupported restrictions",
  {
    concurrency: false,
    skip: processRuntimeTestSkip,
  },
  () => {
    assert.throws(
      () =>
        createPool({
          threads: 1,
          worker: {
            runtime: "process",
            processRuntime: "node",
          },
          permission: {
            mode: "strict",
            net: ["api.example.com:443"],
          },
        })({ addOnePromise }),
      /Node.*process workers cannot enforce.*permission\.net/is,
    );
  },
);

test("process worker spawns a Bun child from this runtime", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("bun")) return;
  await runProcessWorkerSmoke("bun");
});

test("process worker pools use shared-submit stealing by default", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("bun")) return;
  await runProcessWorkerSmoke("bun", undefined, 2);
});

const runProcessStealSmoke = async (
  processRuntime: "bun" | "deno" | "node",
  slots: 32 | 64 = 32,
  threads = 3,
) => {
  const pool = createPool({
    threads,
    host: { steal: true, slots },
    worker: {
      runtime: "process",
      processRuntime,
    },
  })({ double, concat });

  let testError: unknown;
  try {
    const results = await Promise.all(
      Array.from(
        { length: 180 },
        (_, index) =>
          index % 2 === 0
            ? withTimeout(
              `${processRuntime} process worker double ${index}`,
              pool.call.double(index),
            )
            : withTimeout(
              `${processRuntime} process worker concat ${index}`,
              pool.call.concat(`v${index}`),
            ),
      ),
    );
    for (let index = 0; index < results.length; index++) {
      assert.equal(
        results[index],
        index % 2 === 0 ? index * 2 : `v${index}!`,
      );
    }
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      `${processRuntime} process stealing shutdown`,
      pool.shutdown(),
      testError,
    );
  }
};

test("process workers steal a shared submit queue", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("bun")) return;
  await runProcessStealSmoke("bun");
});

test("Deno process workers steal a shared submit queue", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("deno")) return;
  await runProcessStealSmoke("deno");
});

test("Node process workers steal a shared submit queue", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("node")) return;
  await runProcessStealSmoke("node");
});

test("process workers read maxAwaitingTasks: Infinity as unlimited", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("node")) return;
  // The boot payload crosses as JSON, which turns `Infinity` into `null`.
  const pool = createPool({
    threads: 2,
    worker: {
      runtime: "process",
      processRuntime: "node",
      maxAwaitingTasks: Number.POSITIVE_INFINITY,
    },
  })({ double });

  let testError: unknown;
  try {
    assert.equal(
      await withTimeout("unlimited process worker call", pool.call.double(21)),
      42,
    );
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      "unlimited process worker shutdown",
      pool.shutdown(),
      testError,
    );
  }
});

for (const processRuntime of ["bun", "deno", "node"] as const) {
  for (const threads of [1, 3]) {
    test(`64-slot ${processRuntime} process queues complete (${threads} workers)`, {
      concurrency: false,
      skip: processRuntimeTestSkip,
      timeout: TEST_TIMEOUT_MS,
    }, async () => {
      if (!hasProcessRuntime(processRuntime)) return;
      await runProcessStealSmoke(processRuntime, 64, threads);
    });
  }
}

/**
 * Stealing puts every claimant on one abort bitmap carved from the same
 * process-shared mapping as the submit region, so an abort raised on the host
 * has to be visible to whichever child process claimed the task. Tasks come
 * from a single module on purpose: pool ids are assigned per import, so a
 * multi-module pool is a separate (pre-existing) matter.
 */
test("process workers share abort signals across every claimant", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("bun")) return;

  const pool = createPool({
    threads: 3,
    host: { steal: true },
    worker: {
      runtime: "process",
      processRuntime: "bun",
    },
  })({ abortReturnsInput });

  let testError: unknown;
  try {
    for (let round = 0; round < 5; round++) {
      const pending = pool.call.abortReturnsInput(`round-${round}`);
      pending.reject();
      assert.equal(
        await withTimeout(
          `Bun process worker abort ${round}`,
          pending,
        ),
        `round-${round}`,
      );
    }
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      "Bun process abort stealing shutdown",
      pool.shutdown(),
      testError,
    );
  }
});

test("Bubblewrap process workers steal a shared submit queue", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasCommand("bwrap") || !hasProcessRuntime("bun")) return;

  const pool = createPool({
    threads: 2,
    host: { steal: true },
    worker: {
      runtime: "process",
      processRuntime: "bun",
      processCommandPrefix: [
        "bwrap",
        "--unshare-all",
        "--ro-bind",
        "/",
        "/",
        "--dev-bind",
        "/dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--die-with-parent",
      ],
    },
  })({ double });

  let testError: unknown;
  try {
    const results = await Promise.all(
      Array.from(
        { length: 80 },
        (_, index) =>
          withTimeout(
            `Bubblewrap process worker double ${index}`,
            pool.call.double(index),
          ),
      ),
    );
    for (let index = 0; index < results.length; index++) {
      assert.equal(results[index], index * 2);
    }
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      "Bubblewrap process stealing shutdown",
      pool.shutdown(),
      testError,
    );
  }
});

test("process worker spawns a Deno child from this runtime", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("deno")) return;
  await runProcessWorkerSmoke("deno");
});

test("process worker spawns a Node child from this runtime", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("node")) return;
  await runProcessWorkerSmoke("node");
});

if (bunMacOSNamedSharedMemorySkip) {
  test.skip("process worker supports named shared memory", () => {});
} else {
  test("process worker supports named shared memory", {
    concurrency: false,
    skip: processRuntimeTestSkip,
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    for (const processRuntime of ["bun", "deno", "node"] as const) {
      if (!hasProcessRuntime(processRuntime)) continue;
      await runProcessWorkerSmoke(processRuntime, {
        processSharedMemory: {
          mode: "named",
          namePrefix: `knit_test_${processRuntime}`,
        },
      }, 2);
    }
  });
}

test("process worker supports a command prefix wrapper", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasCommand("env")) return;
  for (const processRuntime of ["bun", "deno", "node"] as const) {
    if (!hasProcessRuntime(processRuntime)) continue;
    await runProcessWorkerSmoke(processRuntime, {
      processCommandPrefix: ["env"],
    });
  }
});

test("process workers reject process-local pointer payloads and stay healthy", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  for (const processRuntime of ["bun", "deno", "node"] as const) {
    if (!hasProcessRuntime(processRuntime)) continue;

    const pool = createPool({
      threads: 1,
      worker: {
        runtime: "process",
        processRuntime,
      },
      payload: {
        payloadMaxByteLength: 1024 * 1024,
      },
    })({
      addOnePromise,
      returnSharedArrayBuffer,
    });

    let testError: unknown;
    try {
      await assert.rejects(
        () =>
          withTimeout(
            `${processRuntime} process worker SharedArrayBuffer rejection`,
            pool.call.returnSharedArrayBuffer(),
          ),
        /cannot cross a process-worker boundary.*ProcessSharedBuffer/i,
      );
      assert.equal(
        await withTimeout(
          `${processRuntime} process worker post-rejection health`,
          pool.call.addOnePromise(41),
        ),
        42,
      );
    } catch (error) {
      testError = error;
      throw error;
    } finally {
      await shutdownWithTimeout(
        `${processRuntime} process worker pointer rejection shutdown`,
        pool.shutdown(),
        testError,
      );
    }
  }
});

test("Deno process worker honors runtime permission flags", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("deno")) return;

  const pool = createPool({
    threads: 1,
    worker: {
      runtime: "process",
      processRuntime: "deno",
    },
    permission: {
      mode: "strict",
      allowImport: true,
    },
    payload: {
      payloadMaxByteLength: 1024 * 1024,
    },
  })({
    spawnChildProcess,
  });

  let testError: unknown;
  try {
    await withTimeout(
      "Deno process worker permission rejection assertion",
      assert.rejects(
        () =>
          withTimeout(
            "Deno process worker spawnChildProcess",
            pool.call.spawnChildProcess(),
          ),
        /permission|notcapable|requires.*run/i,
      ),
    );
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      "Deno process worker permission test shutdown",
      pool.shutdown(),
      testError,
    );
  }
});

test("Node process worker strict permissions block child processes", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("node")) return;

  const pool = createPool({
    threads: 1,
    worker: {
      runtime: "process",
      processRuntime: "node",
    },
    permission: {
      mode: "strict",
      allowImport: true,
    },
    payload: {
      payloadMaxByteLength: 1024 * 1024,
    },
  })({
    spawnChildProcess,
  });

  let testError: unknown;
  try {
    await assert.rejects(
      () =>
        withTimeout(
          "Node process worker strict child-process rejection",
          pool.call.spawnChildProcess(),
        ),
      /access.*restricted|permission|ERR_ACCESS_DENIED|child.?process/i,
    );
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      "Node process worker strict permission shutdown",
      pool.shutdown(),
      testError,
    );
  }
});

test("Node process worker explicit run permission allows child processes", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("node")) return;

  const pool = createPool({
    threads: 1,
    worker: {
      runtime: "process",
      processRuntime: "node",
    },
    permission: {
      mode: "strict",
      allowImport: true,
      run: true,
    },
    payload: {
      payloadMaxByteLength: 1024 * 1024,
    },
  })({
    spawnChildProcess,
  });

  let testError: unknown;
  try {
    assert.equal(
      await withTimeout(
        "Node process worker allowed child process",
        pool.call.spawnChildProcess(),
      ),
      "spawn-ok",
    );
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      "Node process worker allowed permission shutdown",
      pool.shutdown(),
      testError,
    );
  }
});

test("Node process worker completes calls after an idle period", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!isPlainNode || !hasProcessRuntime("node")) return;

  const pool = createPool({
    threads: 1,
    worker: {
      runtime: "process",
      processRuntime: "node",
      timers: {
        spinMicroseconds: 0,
        parkMs: 5_000,
      },
    },
    payload: {
      payloadMaxByteLength: 1024 * 1024,
    },
  })({
    addOnePromise,
  });

  let testError: unknown;
  try {
    // Check results after startup and an idle period; elapsed time depends on
    // runner scheduling and is not a correctness assertion.
    assert.equal(
      await withTimeout(
        "parked Node process worker boot call",
        pool.call.addOnePromise(0),
      ),
      1,
    );
    await withTimeout("parked Node process worker park delay", delay(200));

    const value = await withTimeout(
      "parked Node process worker addOnePromise",
      pool.call.addOnePromise(41),
      15_000,
    );

    assert.equal(value, 42);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      "parked Node process worker shutdown",
      pool.shutdown(),
      testError,
    );
  }
});

test("Node process IPC completion doorbell settles a directly armed host", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!isPlainNode || !hasProcessRuntime("node")) return;

  const pool = createPool({
    threads: 1,
    host: { doorbell: true, stallFreeLoops: 0 },
    worker: {
      runtime: "process",
      processRuntime: "node",
      timers: { spinMicroseconds: 0, parkMs: 5_000 },
    },
  })({ addOnePromise });

  let testError: unknown;
  try {
    const values = await Promise.all(
      Array.from(
        { length: 64 },
        (_, value) =>
          withTimeout(
            `Node IPC completion doorbell value ${value}`,
            pool.call.addOnePromise(value),
          ),
      ),
    );
    assert.deepEqual(
      values,
      Array.from({ length: 64 }, (_, value) => value + 1),
    );
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    await shutdownWithTimeout(
      "Node IPC completion doorbell shutdown",
      pool.shutdown(),
      testError,
    );
  }
});

for (const processRuntime of ["node", "bun", "deno"] as const) {
  test(`${processRuntime} process completion rings flush between synchronous batches`, {
    concurrency: false,
    skip: processRuntimeTestSkip ||
      (runtimePlatform === "win32" && typeof versions?.bun === "string" &&
          processRuntime === "bun"
        ? "Bun Windows completion-ring timeout followed by a runtime crash"
        : false),
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    if (!hasProcessRuntime(processRuntime)) return;
    const pool = createPool({
      threads: 4,
      host: { steal: false, doorbell: true, stallFreeLoops: 0 },
      worker: { runtime: "process", processRuntime },
    })({ double });
    try {
      await withTimeout("boot completion-ring worker", pool.call.double(0));
      for (let batch = 0; batch < 16; ++batch) {
        const values = await withTimeout(
          "synchronous batch completes",
          Promise.all(Array.from({ length: 64 }, (_, i) => pool.call.double(i))),
          15_000,
        );
        assert.deepEqual(values, Array.from({ length: 64 }, (_, i) => i * 2));
      }
    } finally {
      await shutdownWithTimeout("completion-ring batch shutdown", pool.shutdown());
    }
  });
}

for (const processRuntime of ["node", "bun", "deno"] as const) {
  for (const threads of [1, 2, 4]) {
    for (const steal of [false, true]) {
      test(
        `${processRuntime} async park admits work without polling (${threads} workers, steal=${steal})`,
        {
          concurrency: false,
          skip: processRuntimeTestSkip,
          timeout: TEST_TIMEOUT_MS,
        },
        async () => {
          if (!hasProcessRuntime(processRuntime)) return;
          const pool = createPool({
            threads,
            host: { steal },
            worker: {
              runtime: "process",
              processRuntime,
              timers: { spinMicroseconds: 0, parkMs: 5_000 },
            },
          })({ holdForAsyncPark, readAsyncParkPolls, double });
          try {
            await withTimeout("boot async park worker", pool.call.double(1));
            const held = pool.call.holdForAsyncPark(400);
            await delay(100);
            // Exercise repeated park/wake transitions and publications racing
            // with the long task's final settlement.
            for (let batch = 0; batch < 12; batch++) {
              const values = await withTimeout(
                "publish while awaiting",
                Promise.all(
                  Array.from(
                    { length: 16 },
                    (_, value) => pool.call.double(value),
                  ),
                ),
              );
              assert.deepEqual(
                values,
                Array.from({ length: 16 }, (_, value) => value * 2),
              );
              await delay(25);
            }
            assert.equal(await withTimeout("last await settles", held), 0);
            assert.equal(
              await withTimeout(
                "dispatch after settlement",
                pool.call.readAsyncParkPolls(),
              ),
              0,
            );
          } finally {
            await shutdownWithTimeout("async park shutdown", pool.shutdown());
          }
        },
      );
    }
  }

  for (const maxAwaitingTasks of [1, 2] as const) {
    test(`${processRuntime} async park resumes capped admission (${maxAwaitingTasks})`, {
      concurrency: false,
      skip: processRuntimeTestSkip,
      timeout: TEST_TIMEOUT_MS,
    }, async () => {
      if (!hasProcessRuntime(processRuntime)) return;
      const pool = createPool({
        threads: 2,
        worker: { runtime: "process", processRuntime, maxAwaitingTasks },
      })({ holdForAsyncPark, double, rejectAfterAsyncPark, abortReturnsInput });
      try {
        await assert.rejects(
          () =>
            withTimeout(
              "async parked rejection",
              pool.call.rejectAfterAsyncPark(),
            ),
          /awaited task rejected/,
        );
        const aborted = pool.call.abortReturnsInput("aborted");
        await delay(30);
        aborted.reject();
        assert.equal(await withTimeout("async parked abort", aborted), "aborted");
        await withTimeout(
          "capped awaited work settles",
          Promise.all(
            Array.from(
              { length: 24 },
              (_, i) => pool.call.holdForAsyncPark(30 + i % 5),
            ),
          ),
        );
        assert.equal(
          await withTimeout("capped dispatch resumes", pool.call.double(21)),
          42,
        );
        const pending = pool.call.holdForAsyncPark(30_000);
        const rejected = assert.rejects(pending);
        await delay(100);
        await shutdownWithTimeout("shutdown during async park", pool.shutdown());
        await rejected;
      } finally {
        await pool.shutdown();
      }
    });
  }

  for (const fallback of ["wrapper", "disconnect"] as const) {
    test(`${processRuntime} async park falls back to polling with ${fallback}`, {
      concurrency: false,
      skip: processRuntimeTestSkip,
      timeout: TEST_TIMEOUT_MS,
    }, async () => {
      if (!hasProcessRuntime(processRuntime)) return;
      if (fallback === "wrapper" && !hasCommand("env")) return;
      const pool = createPool({
        threads: 1,
        host: { doorbell: false },
        worker: {
          runtime: "process",
          processRuntime,
          ...(fallback === "wrapper" ? { processCommandPrefix: ["env"] } : {}),
        },
      })({ holdForAsyncPark, double, disconnectDuringAsyncPark });
      try {
        await withTimeout("boot fallback worker", pool.call.double(1));
        const held = pool.call.holdForAsyncPark(300);
        if (fallback === "disconnect") {
          await withTimeout(
            "schedule disconnect",
            pool.call.disconnectDuringAsyncPark(),
          );
        }
        assert.ok(await withTimeout("fallback await settles", held) > 0);
        assert.equal(
          await withTimeout("fallback admits work", pool.call.double(21)),
          42,
        );
      } finally {
        await shutdownWithTimeout("fallback shutdown", pool.shutdown());
      }
    });
  }

}

for (const failure of ["backpressure", "callback", "throw"] as const) {
  test(`Node async park handles IPC ${failure}`, {
    concurrency: false,
    skip: processRuntimeTestSkip,
    timeout: TEST_TIMEOUT_MS,
  }, async (t) => {
    if (!isPlainNode || !hasProcessRuntime("node")) return;
    const spawn = childProcess.spawn;
    let rings = 0;
    t.mock.method(
      childProcess,
      "spawn",
      (...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        const send = child.send.bind(child);
        child.send =
          ((message: unknown, callback: (error: Error | null) => void) => {
            if (message !== "__knittingWorkerWake") {
              return send(message, callback);
            }
            ++rings;
            if (failure === "throw") {
              throw new Error("injected wake send failure");
            }
            if (failure === "callback") {
              queueMicrotask(() =>
                callback(new Error("injected wake send failure"))
              );
              return false;
            }
            send(message, callback);
            return false;
          }) as typeof child.send;
        return child;
      },
    );
    const pool = createPool({
      threads: 1,
      worker: { runtime: "process", processRuntime: "node" },
    })({ holdForAsyncPark, double });
    try {
      await withTimeout("boot send failure worker", pool.call.double(1));
      // Attach rejection handlers before a deliberately failed ring closes
      // the worker and rejects every accepted call.
      const held = pool.call.holdForAsyncPark(300);
      const settled = held.then(() => "resolved", () => "rejected");
      await delay(100);
      if (failure === "backpressure") {
        assert.equal(
          await withTimeout("backpressured ring", pool.call.double(21)),
          42,
        );
        assert.equal(
          await withTimeout("backpressured await", settled),
          "resolved",
        );
      } else {
        await assert.rejects(
          () =>
            withTimeout("failed ring rejects submission", pool.call.double(21)),
          /injected wake send failure/,
        );
        assert.equal(
          await withTimeout("failed ring rejects await", settled),
          "rejected",
        );
      }
      assert.ok(rings > 0, "test must exercise an async wake send");
    } finally {
      await shutdownWithTimeout("send failure shutdown", pool.shutdown());
    }
  });
}

for (const processRuntime of ["node", "bun", "deno"] as const) {
  for (const steal of [false, true]) {
  test(`${processRuntime} async park enables wake policy only across pending-await transitions (steal=${steal})`, {
    concurrency: false,
    skip: processRuntimeTestSkip,
    timeout: TEST_TIMEOUT_MS,
  }, async (t) => {
    if (!isPlainNode || !hasProcessRuntime(processRuntime)) return;
    const spawn = childProcess.spawn;
    const states: unknown[] = [];
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      child.on("message", (message) => {
        if (message === PROCESS_WORKER_ASYNC_ACTIVE || message === PROCESS_WORKER_ASYNC_IDLE) {
          states.push(message);
        }
      });
      return child;
    });
    const pool = createPool({
      threads: 1,
      host: { steal },
      worker: { runtime: "process", processRuntime },
    })({ holdForAsyncPark, double, addOnePromise });
    const waitForState = async (state: string) => {
      await withTimeout("async population transition", (async () => {
        while (states.at(-1) !== state) await delay(1);
      })());
    };
    try {
      await withTimeout("sync work never enables async policy", Promise.all(
        Array.from({ length: 128 }, (_, i) => pool.call.double(i)),
      ));
      assert.deepEqual(states, []);
      await withTimeout("immediate promises coalesce to idle", Promise.all(
        Array.from({ length: 128 }, (_, i) => pool.call.addOnePromise(i)),
      ));
      await delay(30);
      assert.deepEqual(states, []);
      const held = pool.call.holdForAsyncPark(300);
      await waitForState(PROCESS_WORKER_ASYNC_ACTIVE);
      assert.equal(await withTimeout("pending await settles", held), 0);
      // No new publication is needed to flush the last-await transition before
      // the worker goes back to its blocking native wait.
      await waitForState(PROCESS_WORKER_ASYNC_IDLE);
      await withTimeout("sync work returns to original policy", Promise.all(
        Array.from({ length: 128 }, (_, i) => pool.call.double(i)),
      ));
      await delay(30);
      assert.deepEqual(states, [PROCESS_WORKER_ASYNC_ACTIVE, PROCESS_WORKER_ASYNC_IDLE]);
    } finally {
      await shutdownWithTimeout("population transition shutdown", pool.shutdown());
    }
  });
  }

}

test("Node native process wake coalesces publications while a parked child is stopped", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  if (!isPlainNode || runtimePlatform !== "linux" || !hasProcessRuntime("node")) return;
  const spawn = childProcess.spawn;
  const children: ReturnType<typeof spawn>[] = [];
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  });
  const futex = loadNodeFutexAddon();
  const wake = futex.wakeU32;
  let rings = 0;
  t.mock.method(futex, "wakeU32", (...args: Parameters<typeof wake>) => {
    ++rings;
    return wake(...args);
  });
  const pool = createPool({
    threads: 2,
    host: { steal: true },
    worker: {
      runtime: "process",
      processRuntime: "node",
      timers: { spinMicroseconds: 0, parkMs: 5000 },
    },
  })({ double });
  try {
    assert.equal(await withTimeout("boot native coalescing worker", pool.call.double(1)), 2);
    await delay(200);
    for (const child of children) assert.ok(child.kill("SIGSTOP"));
    await delay(20);
    rings = 0;
    const pending = Promise.all(Array.from({ length: 32 }, (_, i) => pool.call.double(i)));
    pending.catch(() => {});
    await delay(20);
    assert.ok(rings > 0 && rings <= children.length,
      `stopped workers must receive at most one ring per park, got ${rings}`);
    for (const child of children) assert.ok(child.kill("SIGCONT"));
    assert.deepEqual(
      await withTimeout("coalesced burst resumes", pending),
      Array.from({ length: 32 }, (_, i) => i * 2),
    );
  } finally {
    for (const child of children) child.kill("SIGCONT");
    await shutdownWithTimeout("native coalescing shutdown", pool.shutdown());
  }
});

test("Node async park wakes the peer with capacity when other awaits never settle", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  if (!isPlainNode || !hasProcessRuntime("node")) return;
  const spawn = childProcess.spawn;
  const pids: number[] = [];
  const counts = new Map<number, number>();
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    if (child.pid !== undefined) pids.push(child.pid);
    child.on("message", (message) => {
      const state = message as { __knittingCapacityHeld?: number; pid?: number };
      if (typeof state?.__knittingCapacityHeld === "number" && typeof state.pid === "number") {
        counts.set(state.pid, state.__knittingCapacityHeld);
      }
    });
    return child;
  });
  const pool = createPool({
    threads: 4,
    host: { steal: true },
    worker: { runtime: "process", processRuntime: "node", maxAwaitingTasks: 2 },
  })({ occupyAsyncCapacity, double });
  const held: Promise<unknown>[] = [];
  try {
    await withTimeout("boot capacity workers", pool.call.double(1));
    assert.equal(pids.length, 4);
    // Fill three workers. The fourth remains available to drain mismatched
    // targeting calls until it receives its one deliberately pending task.
    for (const pid of pids.slice(0, 3)) {
      const deadline = performance.now() + PROMISE_TIMEOUT_MS;
      while ((counts.get(pid) ?? 0) < 2) {
        held.push(pool.call.occupyAsyncCapacity(pid).catch(() => null));
        if (performance.now() > deadline) throw new Error("could not fill async capacity");
        await delay(5);
      }
    }
    const available = pids[3]!;
    held.push(pool.call.occupyAsyncCapacity(available).catch(() => null));
    const deadline = performance.now() + PROMISE_TIMEOUT_MS;
    while (counts.get(available) !== 1) {
      if (performance.now() > deadline) throw new Error("available peer did not begin its await");
      await delay(1);
    }
    await delay(30);
    for (let i = 0; i < 16; i++) {
      assert.equal(
        await withTimeout("free peer admits work", pool.call.double(i), 15_000),
        i * 2,
      );
    }
  } finally {
    await shutdownWithTimeout("shutdown full async parks", pool.shutdown());
    await Promise.all(held);
  }
});

for (const processRuntime of ["node", "bun", "deno"] as const) {
  for (const dispatcher of ["per-thread", "serial-channel"] as const) {
  test(`${processRuntime} async activation keeps admitting work while the host cannot process IPC (${dispatcher})`, {
    concurrency: false,
    skip: processRuntimeTestSkip,
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    if (!hasProcessRuntime(processRuntime)) return;
    const directory = mkdtempSync(join(tmpdir(), "knitting-async-ready-"));
    const marker = join(directory, "awaiting");
    const pool = createPool({
      threads: 1,
      host: { steal: false, dispatcher },
      permission: { mode: "unsafe" },
      worker: { runtime: "process", processRuntime },
    })({ awaitWithMarker, markAsyncClaim, double });
    try {
      await withTimeout("boot activation worker", pool.call.double(1));
      pool.call.awaitWithMarker(marker).catch(() => {});
      const deadline = performance.now() + PROMISE_TIMEOUT_MS;
      // Keep the host's message loop blocked throughout the transition. The
      // child must retain its timer fallback until the host publishes readiness.
      while (!existsSync(marker)) {
        if (performance.now() > deadline) throw new Error("await did not start");
      }
      let until = performance.now() + 25;
      while (performance.now() < until) {}
      const claimMarker = join(directory, "claimed");
      const claimed = pool.call.markAsyncClaim(claimMarker);
      until = performance.now() + 100;
      while (performance.now() < until) {}
      // Check before yielding: runtimes use different hrtime epochs, so a file
      // marker proves admission without comparing their clocks.
      assert.ok(existsSync(claimMarker), "task did not run while the host was blocked");
      await withTimeout("claim during blocked activation", claimed);
      await delay(30);
      const steadyMarker = join(directory, "steady");
      const steady = pool.call.markAsyncClaim(steadyMarker);
      until = performance.now() + 100;
      while (performance.now() < until) {}
      assert.ok(existsSync(steadyMarker), "task did not run during steady async park");
      await withTimeout("claim during steady async park", steady);
    } finally {
      await shutdownWithTimeout("activation handshake shutdown", pool.shutdown());
      rmSync(directory, { recursive: true, force: true });
    }
  });
  }
}
