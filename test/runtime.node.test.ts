import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
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
  fetchNetworkProbe,
  nodeHttpNetworkProbe,
  nodeNetNetworkProbe,
  readEnvVar,
  readDeniedViaSymlink,
  readGitDirectory,
  spawnChildProcess,
  spawnChildProcessLegacySpecifier,
  spawnViaProcessBinding,
  spawnViaWorkerThread,
  tamperPerformanceNow,
  writeIntoNodeModules,
} from "./fixtures/permission_tasks.ts";
import {
  returnFunction,
  returnLocalSymbol,
  returnWeakMap,
} from "./fixtures/error_tasks.ts";
import {
  addOneLimitProbe,
  runawayCpuLoop,
} from "./fixtures/limit_tasks.ts";

const TEST_TIMEOUT_MS = 10_000;
const NODE_BIN = process.versions.bun ? "node" : process.execPath;
const NODE_CHILD_ARGS = (() => {
  const probe = spawnSync(
    NODE_BIN,
    ["--experimental-transform-types", "--eval", "void 0"],
    { stdio: "ignore" },
  );

  if (probe.status === 0) {
    return ["--no-warnings", "--experimental-transform-types"];
  }

  return ["--no-warnings"];
})();
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
      [...NODE_CHILD_ARGS, scriptPath],
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

const isPermissionDenied = (error: unknown): boolean => {
  const text = String(error);
  return text.includes("KNT_ERROR_PERMISSION_DENIED") ||
    text.includes("ERR_ACCESS_DENIED");
};

const assertNotPermissionDenied = (error: unknown): void => {
  assert.equal(isPermissionDenied(error), false);
};

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

test("node:test permission unsafe mode allows unrestricted file access", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (process.versions.bun) {
    return;
  }

  const nodeModulesOutput = path.resolve(
    process.cwd(),
    "node_modules",
    ".knitting-permission-probe.tmp",
  );
  const nodeModulesDir = path.dirname(nodeModulesOutput);
  const hadNodeModulesDir = existsSync(nodeModulesDir);
  const envProbeKey = "KNT_PERMISSION_ENV_PROBE";
  const previousEnvProbe = process.env[envProbeKey];
  process.env[envProbeKey] = "probe-value";
  const blockedNetworkUrl = "http://127.0.0.1:9/";
  if (!hadNodeModulesDir) {
    mkdirSync(nodeModulesDir, { recursive: true });
  }
  const pool = createPool({
    threads: 1,
    permission: "unsafe",
  })({
    writeIntoNodeModules,
    readGitDirectory,
    readEnvVar,
    fetchNetworkProbe,
    nodeHttpNetworkProbe,
    nodeNetNetworkProbe,
    spawnChildProcess,
    spawnChildProcessLegacySpecifier,
    spawnViaWorkerThread,
    spawnViaProcessBinding,
    readDeniedViaSymlink,
  });

  try {
    if (existsSync(nodeModulesOutput)) {
      unlinkSync(nodeModulesOutput);
    }

    const out = await withTimeout(pool.call.writeIntoNodeModules(), TEST_TIMEOUT_MS);
    assert.equal(out, nodeModulesOutput);
    assert.equal(existsSync(nodeModulesOutput), true);

    const gitEntries = await withTimeout(pool.call.readGitDirectory(), TEST_TIMEOUT_MS);
    assert.equal(gitEntries > 0, true);

    const envProbe = await withTimeout(pool.call.readEnvVar(envProbeKey), TEST_TIMEOUT_MS);
    assert.equal(envProbe, "probe-value");

    const fetchResult = await withTimeout(
      pool.call.fetchNetworkProbe(blockedNetworkUrl).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      ),
      TEST_TIMEOUT_MS,
    );
    if (!fetchResult.ok) {
      assertNotPermissionDenied(fetchResult.error);
    }

    const httpResult = await withTimeout(
      pool.call.nodeHttpNetworkProbe(blockedNetworkUrl).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      ),
      TEST_TIMEOUT_MS,
    );
    if (!httpResult.ok) {
      assertNotPermissionDenied(httpResult.error);
    }

    const netResult = await withTimeout(
      pool.call.nodeNetNetworkProbe({ host: "127.0.0.1", port: 9 }).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      ),
      TEST_TIMEOUT_MS,
    );
    if (!netResult.ok) {
      assertNotPermissionDenied(netResult.error);
    }

    const spawnResult = await withTimeout(
      pool.call.spawnChildProcess().then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      ),
      TEST_TIMEOUT_MS,
    );
    if (spawnResult.ok) {
      assert.equal(spawnResult.value, "spawn-ok");
    } else {
      assertNotPermissionDenied(spawnResult.error);
    }

    const legacySpawnResult = await withTimeout(
      pool.call.spawnChildProcessLegacySpecifier().then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      ),
      TEST_TIMEOUT_MS,
    );
    if (legacySpawnResult.ok) {
      assert.equal(legacySpawnResult.value, "spawn-legacy-ok");
    } else {
      assertNotPermissionDenied(legacySpawnResult.error);
    }

    const workerResult = await withTimeout(
      pool.call.spawnViaWorkerThread().then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      ),
      TEST_TIMEOUT_MS,
    );
    if (workerResult.ok) {
      assert.equal(typeof workerResult.value, "string");
    } else {
      assertNotPermissionDenied(workerResult.error);
    }

    const bindingResult = await withTimeout(
      pool.call.spawnViaProcessBinding().then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      ),
      TEST_TIMEOUT_MS,
    );
    if (bindingResult.ok) {
      assert.equal(typeof bindingResult.value, "string");
    } else {
      assertNotPermissionDenied(bindingResult.error);
    }

    if (process.platform !== "win32") {
      const hosts = await withTimeout(pool.call.readDeniedViaSymlink(), TEST_TIMEOUT_MS);
      assert.equal(typeof hosts, "string");
      assert.equal(hosts.length > 0, true);
    }
  } finally {
    await pool.shutdown();
    if (existsSync(nodeModulesOutput)) {
      unlinkSync(nodeModulesOutput);
    }
    if (!hadNodeModulesDir && existsSync(nodeModulesDir)) {
      rmSync(nodeModulesDir, { recursive: true, force: true });
    }
    if (previousEnvProbe === undefined) {
      delete process.env[envProbeKey];
    } else {
      process.env[envProbeKey] = previousEnvProbe;
    }
  }
});

test("node:test worker keeps performance.now precise and tamper-resistant", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const pool = createPool({
    threads: 1,
  })({
    tamperPerformanceNow,
  });

  try {
    const result = await withTimeout(pool.call.tamperPerformanceNow(), TEST_TIMEOUT_MS);
    assert.equal(typeof result.changedToZero, "boolean");
    assert.equal(typeof result.replacedObject, "boolean");
    assert.equal(result.stableSample > 0, true);
  } finally {
    await pool.shutdown();
  }
});

test("node:test worker hard timeout force-shuts pool on runaway cpu loops", {
  concurrency: false,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  if (process.versions.bun) {
    return;
  }

  const pool = createPool({
    threads: 1,
    worker: {
      hardTimeoutMs: 100,
    },
  })({
    runawayCpuLoop,
    addOneLimitProbe,
  });

  try {
    await assert.rejects(
      withTimeout(pool.call.runawayCpuLoop(), TEST_TIMEOUT_MS),
      /Task hard timeout after 100ms/,
    );
    await assert.rejects(
      pool.call.addOneLimitProbe(1),
      /Pool is shut down/,
    );
  } finally {
    await pool.shutdown();
  }
});
