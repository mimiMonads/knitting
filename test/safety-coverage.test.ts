import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withResolvers } from "../src/common/with-resolvers.ts";
import {
  assertWorkerImportsResolved,
  assertWorkerSharedMemoryBootData,
} from "../src/worker/safety/startup.ts";
import type { LockBuffers } from "../src/types.ts";

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

const processGuardDirectProbePath = fileURLToPath(
  new URL("./fixtures/probes/process_guard_direct_probe.ts", import.meta.url),
);
const processGuardFallbackProbePath = fileURLToPath(
  new URL("./fixtures/probes/process_guard_fallback_probe.ts", import.meta.url),
);
const processGuardEarlyReturnProbePath = fileURLToPath(
  new URL("./fixtures/probes/process_guard_early_return_probe.ts", import.meta.url),
);

const makeLockBuffers = (): LockBuffers => ({
  headers: new SharedArrayBuffer(8),
  lockSector: new SharedArrayBuffer(8),
  payload: new SharedArrayBuffer(8),
  payloadSector: new SharedArrayBuffer(8),
});

const runProbe = (scriptPath: string) =>
  spawnSync(
    NODE_BIN,
    [...NODE_CHILD_ARGS, scriptPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

test("withResolvers uses native Promise.withResolvers when available", {
  concurrency: false,
}, async () => {
  const ctor = Promise as PromiseConstructor & {
    withResolvers?: <T>() => {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  };
  const descriptor = Object.getOwnPropertyDescriptor(ctor, "withResolvers");
  if (!descriptor || (descriptor.configurable !== true && descriptor.writable !== true)) {
    return;
  }

  let callCount = 0;
  Object.defineProperty(ctor, "withResolvers", {
    configurable: true,
    writable: true,
    value: <T>() => {
      callCount += 1;
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
  });

  try {
    const deferred = withResolvers<string>();
    assert.equal(callCount, 1);
    deferred.resolve("native");
    await assert.doesNotReject(deferred.promise);
    assert.equal(await deferred.promise, "native");
  } finally {
    Object.defineProperty(ctor, "withResolvers", descriptor);
  }
});

test("withResolvers falls back to Promise constructor when native helper is absent", {
  concurrency: false,
}, async () => {
  const ctor = Promise as PromiseConstructor & { withResolvers?: unknown };
  const descriptor = Object.getOwnPropertyDescriptor(ctor, "withResolvers");
  if (!descriptor || (descriptor.configurable !== true && descriptor.writable !== true)) {
    return;
  }

  Object.defineProperty(ctor, "withResolvers", {
    configurable: true,
    writable: true,
    value: undefined,
  });

  try {
    const resolved = withResolvers<number>();
    resolved.resolve(7);
    assert.equal(await resolved.promise, 7);

    const rejected = withResolvers<void>();
    rejected.reject(new Error("fallback rejection"));
    await assert.rejects(rejected.promise, /fallback rejection/);
  } finally {
    Object.defineProperty(ctor, "withResolvers", descriptor);
  }
});

test("startup guard accepts valid shared memory boot data", () => {
  assert.doesNotThrow(() => {
    assertWorkerSharedMemoryBootData({
      sab: new SharedArrayBuffer(8),
      lock: makeLockBuffers(),
      returnLock: makeLockBuffers(),
    });
  });
});

test("startup guard rejects missing shared memory boot buffers", () => {
  assert.throws(() => {
    assertWorkerSharedMemoryBootData({
      sab: undefined,
      lock: makeLockBuffers(),
      returnLock: makeLockBuffers(),
    });
  }, /worker missing transport SAB/);

  assert.throws(() => {
    assertWorkerSharedMemoryBootData({
      sab: new SharedArrayBuffer(8),
      lock: undefined,
      returnLock: makeLockBuffers(),
    });
  }, /worker missing lock SABs/);

  assert.throws(() => {
    assertWorkerSharedMemoryBootData({
      sab: new SharedArrayBuffer(8),
      lock: makeLockBuffers(),
      returnLock: undefined,
    });
  }, /worker missing return lock SABs/);
});

test("startup import assertion logs debug list and returns when imports exist", {
  concurrency: false,
}, () => {
  const messages: unknown[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    messages.push(...args);
  };

  try {
    assert.doesNotThrow(() => {
      assertWorkerImportsResolved({
        debug: { logImportedUrl: true },
        list: ["./a.ts"],
        ids: [1],
        listOfFunctions: [() => 1],
      });
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], ["./a.ts"]);
});

test("startup import assertion throws when no imports are resolved", {
  concurrency: false,
}, () => {
  const messages: unknown[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    messages.push(...args);
  };

  try {
    assert.throws(() => {
      assertWorkerImportsResolved({
        debug: undefined,
        list: ["./missing.ts"],
        ids: [5],
        listOfFunctions: [],
      });
    }, /No imports were found\./);
  } finally {
    console.log = originalLog;
  }

  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], ["./missing.ts"]);
  assert.deepEqual(messages[1], [5]);
  assert.deepEqual(messages[2], []);
});

test("process guard probe covers direct install path", () => {
  const result = runProbe(processGuardDirectProbePath);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test("process guard probe covers Object.defineProperty fallback path", () => {
  const result = runProbe(processGuardFallbackProbePath);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test("process guard probe covers early-return path when process is unavailable", () => {
  const result = runProbe(processGuardEarlyReturnProbePath);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});
