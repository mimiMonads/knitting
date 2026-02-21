import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPool } from "../knitting.ts";
import {
  toBigInt,
  toNumber,
  toString,
} from "./fixtures/parameter_tasks.ts";
import {
  addOnePromise,
  addOnePromiseViaPath,
} from "./fixtures/runtime_tasks.ts";
import {
  returnFunction,
  returnLocalSymbol,
  returnWeakMap,
} from "./fixtures/error_tasks.ts";

const TEST_TIMEOUT_MS = 10_000;
const NODE_BIN = process.versions.bun ? "node" : process.execPath;
const faultConstructorProbePath = fileURLToPath(
  new URL("./fixtures/probes/fault_constructor_probe.ts", import.meta.url),
);
const processGuardProbePath = fileURLToPath(
  new URL("./fixtures/probes/process_guard_probe.ts", import.meta.url),
);
const sharedMemoryCorruptionProbePath = fileURLToPath(
  new URL("./fixtures/probes/shared_memory_corruption_probe.ts", import.meta.url),
);

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

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
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

const runProbe = (scriptPath: string, timeoutMs = 4_000): Promise<ChildResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      NODE_BIN,
      ["--no-warnings", "--experimental-transform-types", scriptPath],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({
        code: null,
        signal: "SIGKILL",
        stderr,
        stdout,
        timedOut: true,
      });
    }, timeoutMs);

    child.once("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve({
        code,
        signal,
        stderr,
        stdout,
        timedOut: false,
      });
    });
  });

test("node:test pool round-trips core payloads", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { call, shutdown } = createPool({
    threads: 2,
  })({
    toNumber,
    toString,
    toBigInt,
  });

  try {
    const results = await withTimeout(
      Promise.all([
        call.toString("hello"),
        call.toNumber(42),
        call.toBigInt(2n ** 64n - 1n),
      ]),
      TEST_TIMEOUT_MS,
    );

    assert.equal(results[0], "hello");
    assert.equal(results[1], 42);
    assert.equal(results[2], 2n ** 64n - 1n);
  } finally {
    await shutdown();
  }
});

test("node:test pool awaits promise inputs", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const pool = createPool({ threads: 1 })({ addOnePromise });

  try {
    const value = await withTimeout(
      pool.call.addOnePromise(Promise.resolve(41)),
      TEST_TIMEOUT_MS,
    );
    assert.equal(value, 42);
  } finally {
    await pool.shutdown();
  }
});

test("node:test pool imports task module from filesystem href", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const pool = createPool({ threads: 1 })({ addOnePromiseViaPath });

  try {
    const value = await withTimeout(
      pool.call.addOnePromiseViaPath(Promise.resolve(10)),
      TEST_TIMEOUT_MS,
    );
    assert.equal(value, 11);
  } finally {
    await pool.shutdown();
  }
});

test("node:test pool rejects when worker cannot encode returned payload", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const pool = createPool({ threads: 1 })({
    returnLocalSymbol,
    returnFunction,
    returnWeakMap,
  });

  try {
    await assert.rejects(
      withTimeout(pool.call.returnLocalSymbol(), TEST_TIMEOUT_MS),
      (error: unknown) => String(error).includes("KNT_ERROR_1"),
    );

    await assert.rejects(
      withTimeout(pool.call.returnFunction(), TEST_TIMEOUT_MS),
      (error: unknown) => String(error).includes("KNT_ERROR_0"),
    );

    await assert.rejects(
      withTimeout(pool.call.returnWeakMap(), TEST_TIMEOUT_MS),
      (error: unknown) => String(error).includes("KNT_ERROR_3"),
    );
  } finally {
    await pool.shutdown();
  }
});

test("node:test constructor poisoning is neutralized and worker stays alive", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const result = await runProbe(faultConstructorProbePath);

  assert.equal(
    result.timedOut,
    false,
    `probe timed out\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(
    result.code,
    0,
    `constructor probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test("node:test worker blocks direct process termination APIs in task functions", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const result = await runProbe(processGuardProbePath);

  assert.equal(
    result.timedOut,
    false,
    `probe timed out\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(
    result.code,
    0,
    `process guard probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test("node:test workerData lock buffers are hidden from task code", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const result = await runProbe(sharedMemoryCorruptionProbePath);

  assert.equal(
    result.timedOut,
    false,
    `probe timed out\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(
    result.code,
    0,
    `shared-memory mitigation probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});
