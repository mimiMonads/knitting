import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import test from "./_runner.ts";
const assertEquals: (actual: unknown, expected: unknown) => void = (
  actual,
  expected,
) => {
  assert.deepStrictEqual(actual, expected);
};
import { createPool } from "../knitting.ts";
import { addOne, delayedEcho } from "./fixtures/loop_tasks.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rootPath = fileURLToPath(new URL("../", import.meta.url));
const knittingHref = pathToFileURL(join(rootPath, "knitting.ts")).href;

const withTimeout = async <T>(promise: Promise<T>, ms: number) => {
  let timeoutId;
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

const currentRuntimeCommand = () => {
  const runtime = globalThis as typeof globalThis & {
    Bun?: { version?: string };
    Deno?: { execPath?: () => string };
    process?: { execPath?: string };
  };

  if (typeof runtime.Deno?.execPath === "function") {
    return { command: runtime.Deno.execPath(), args: ["run", "-A"] };
  }

  const command = runtime.process?.execPath;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Could not resolve runtime executable");
  }

  if (typeof runtime.Bun?.version === "string") {
    return { command, args: [] };
  }

  return {
    command,
    args: ["--no-warnings", "--experimental-transform-types"],
  };
};

test("worker loop progresses across async work and idle periods", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    worker: {
      timers: {
        spinMicroseconds: 10,
        parkMs: 5,
      },
    },
    host: {
      stallFreeLoops: 0,
      maxBackoffMs: 1,
    },
  })({ addOne, delayedEcho });

  try {
    const batch1 = [
      call.addOne(1),
      call.addOne(2),
      call.delayedEcho(5),
    ];
    const result1 = await withTimeout(Promise.all(batch1), 2000);
    assertEquals(result1, [2, 3, 5]);

    // Let the worker go idle, then enqueue another batch to verify wakeup.
    await delay(5);

    const batch2 = [
      call.delayedEcho(2),
      call.addOne(40),
      call.addOne(-1),
    ];
    const result2 = await withTimeout(Promise.all(batch2), 2000);
    assertEquals(result2, [2, 41, 0]);
  } finally {
    await shutdown();
  }
});

test("shutdown supports delayed termination timer", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
  })({ addOne });

  const value = await call.addOne(1);
  assertEquals(value, 2);

  const startedAt = Date.now();
  await shutdown(60);
  const elapsed = Date.now() - startedAt;
  assert.equal(elapsed >= 40, true);
});

test("pool exposes synchronous dispose hook for using", async () => {
  const pool = createPool({
    threads: 1,
  })({ addOne });

  try {
    assertEquals(await pool.call.addOne(1), 2);

    pool[Symbol.dispose]();

    await assert.rejects(
      () => pool.call.addOne(2),
      /Pool is shut down/,
    );
  } finally {
    await pool.shutdown();
  }
});

test("using runs a normal pool call and disposes the pool", () => {
  const tmp = mkdtempSync(join(tmpdir(), "knitting-using-"));
  const scriptPath = join(tmp, "using-pool.mjs");
  const source = `
    import { createPool, isMain } from ${JSON.stringify(knittingHref)};

    export const addOne = (value: number) => value + 1;

    using pool = createPool({ threads: 1 })({ addOne });

    if (isMain) {
      console.log(await pool.call.addOne(41));
    }
  `;
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const runtime = currentRuntimeCommand();

  try {
    writeFileSync(scriptPath, output);
    const result = spawnSync(runtime.command, [...runtime.args, scriptPath], {
      cwd: rootPath,
      encoding: "utf8",
      timeout: 5_000,
    });

    assert.equal(
      result.status,
      0,
      result.stderr || result.error?.message || "using fixture failed",
    );
    // Strip ANSI color codes
    const stdout = result.stdout.replace(/\u001b\[[0-9;]*m/g, "").trim();
    assert.equal(stdout, "42");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispatcher drains oversubscribed batches without stalling", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    host: {
      stallFreeLoops: 0,
      maxBackoffMs: 2,
    },
  })({ addOne });

  try {
    const rounds = 80;
    const batch = 100; // greater than lock slot count (32)

    for (let round = 0; round < rounds; round++) {
      const jobs = Array.from(
        { length: batch },
        (_, index) => call.addOne(round + index),
      );
      const values = await withTimeout(Promise.all(jobs), 3000);
      assert.equal(values.length, batch);
      assert.equal(values[0], round + 1);
      assert.equal(values[batch - 1], round + batch);
    }
  } finally {
    await shutdown();
  }
});

test("serial-channel dispatcher drains multi-lane bursts", async () => {
  const { call, shutdown } = createPool({
    threads: 2,
    host: {
      dispatcher: "serial-channel",
      stallFreeLoops: 0,
      maxBackoffMs: 2,
    },
  })({ addOne });

  try {
    const batch = 96;
    const jobs = Array.from(
      { length: batch },
      (_, index) => call.addOne(index),
    );
    const values = await withTimeout(Promise.all(jobs), 3000);
    assert.equal(values.length, batch);
    assert.equal(values[0], 1);
    assert.equal(values[batch - 1], batch);
  } finally {
    await shutdown();
  }
});
