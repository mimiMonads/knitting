import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "./_runner.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createPool } from "../knitting.ts";
import { loadNodeSharedMemoryAddon } from "../src/connections/node.ts";
import { addOnePromise, reportIsMain } from "./fixtures/runtime_tasks.ts";
import { spawnChildProcess } from "./fixtures/permission_tasks.ts";

const TEST_TIMEOUT_MS = 10_000;
const versions = (globalThis as typeof globalThis & {
  process?: { versions?: { bun?: string; node?: string } };
  Deno?: unknown;
}).process?.versions;
const isPlainNode = typeof versions?.node === "string" &&
  versions.bun === undefined &&
  (globalThis as typeof globalThis & { Deno?: unknown }).Deno === undefined;
let nodeSharedMemoryAddonIsAvailable: boolean | undefined;
let nodeCommandSharedMemoryAddonIsAvailable: boolean | undefined;

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`test timeout after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const hasCommand = (command: string): boolean => {
  try {
    const args = command === "env" ? [] : ["--version"];
    return spawnSync(command, args, { stdio: "ignore" }).status === 0;
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
      },
    );
    return probe.status === 0;
  })();
  return nodeCommandSharedMemoryAddonIsAvailable;
};

const hasProcessRuntime = (command: "bun" | "deno" | "node"): boolean => {
  if (process.platform === "win32") return false;
  if (isPlainNode && !hasNodeSharedMemoryAddon()) return false;
  if (!hasCommand(command)) return false;
  if (
    command === "node" && !isPlainNode && !hasNodeCommandSharedMemoryAddon()
  ) {
    return false;
  }
  return true;
};

test("process worker runtime is POSIX-only", () => {
  if (process.platform !== "win32") return;

  assert.throws(
    () =>
      createPool({
        threads: 1,
        worker: {
          runtime: "process",
          processRuntime: "node",
        },
      })({ addOnePromise }),
    /Process worker runtime is supported on Linux and macOS only/,
  );
});

const runProcessWorkerSmoke = async (
  processRuntime: "bun" | "deno" | "node",
  worker?: {
    processCommandPrefix?: string[];
  },
): Promise<void> => {
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

  try {
    const [value, workerIsMain] = await withTimeout(
      Promise.all([
        pool.call.addOnePromise(41),
        pool.call.reportIsMain(),
      ]),
      TEST_TIMEOUT_MS,
    );

    assert.equal(value, 42);
    assert.equal(workerIsMain, false);
  } finally {
    await pool.shutdown();
  }
};

test("process worker spawns a Bun child from this runtime", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("bun")) return;
  await runProcessWorkerSmoke("bun");
});

test("process worker spawns a Deno child from this runtime", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("deno")) return;
  await runProcessWorkerSmoke("deno");
});

test("process worker spawns a Node child from this runtime", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (!hasProcessRuntime("node")) return;
  await runProcessWorkerSmoke("node");
});

test("process worker supports a command prefix wrapper", {
  concurrency: false,
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

test("Deno process worker honors runtime permission flags", {
  concurrency: false,
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

  try {
    await assert.rejects(
      () => withTimeout(pool.call.spawnChildProcess(), TEST_TIMEOUT_MS),
      /permission|notcapable|requires.*run/i,
    );
  } finally {
    await pool.shutdown();
  }
});

test("Node process worker wakes promptly from a parked native wait", {
  concurrency: false,
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

  try {
    await delay(50);
    const started = performance.now();
    const value = await withTimeout(
      pool.call.addOnePromise(41),
      1_000,
    );

    assert.equal(value, 42);
    assert.ok(
      performance.now() - started < 1_000,
      "parked Node process worker was not woken promptly",
    );
  } finally {
    await pool.shutdown();
  }
});
