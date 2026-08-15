import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "./_runner.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createPool } from "../knitting.ts";
import { loadNodeSharedMemoryAddon } from "../src/connections/node.ts";
import {
  addOnePromise,
  reportIsMain,
  returnSharedArrayBuffer,
} from "./fixtures/runtime_tasks.ts";
import { spawnChildProcess } from "./fixtures/permission_tasks.ts";

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
): Promise<void> => {
  const labels = [`${processRuntime} process worker`];
  if (worker?.processCommandPrefix !== undefined) labels.push("command prefix");
  if (worker?.processSharedMemory !== undefined) labels.push("named shm");
  const workerLabel = labels.join(" with ");
  const pool = createPool({
    threads: 1,
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

test("process workers fail before spawn for explicit unsupported restrictions", {
  concurrency: false,
  skip: processRuntimeTestSkip,
}, () => {
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
});

test("process worker spawns a Bun child from this runtime", {
  concurrency: false,
  skip: processRuntimeTestSkip,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("bun")) return;
  await runProcessWorkerSmoke("bun");
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
      });
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

test("Node process worker wakes promptly from a parked native wait", {
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
    await withTimeout("parked Node process worker startup delay", delay(50));
    const started = performance.now();
    const value = await withTimeout(
      "parked Node process worker addOnePromise",
      pool.call.addOnePromise(41),
    );

    assert.equal(value, 42);
    assert.ok(
      performance.now() - started < 1_000,
      "parked Node process worker was not woken promptly",
    );
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
