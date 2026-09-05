/** Probe Windows park and process-doorbell behavior outside the test suite. */
import { createPool } from "../knitting.ts";
import { RUNTIME } from "../src/common/runtime.ts";
import { double } from "../test/fixtures/steal_tasks.ts";

const nodeProcess = (globalThis as typeof globalThis & {
  process?: {
    platform?: string;
    execPath?: string;
    cpuUsage?: (previous?: unknown) => { user: number; system: number };
    exit?: (code?: number) => never;
  };
}).process;

const platform = nodeProcess?.platform ?? "unknown";
const cpuUsage = nodeProcess?.cpuUsage;

let failures = 0;

const report = (ok: boolean, name: string, detail: string): void => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
};

const note = (name: string, detail: string): void => {
  console.log(`note  ${name} -- ${detail}`);
};

/**
 * Probe: how much CPU does a short `Atomics.wait` timeout cost?
 *
 * Bun on Windows honours a timeout of 1ms or less by spinning, so an idle
 * worker parked at the default `parkMs` of 1 pins a core. From 2ms up it takes
 * a real OS wait. Every other runtime sleeps at any timeout.
 */
const probeShortWaitBurnsCpu = (): void => {
  if (
    typeof Atomics.wait !== "function" ||
    typeof SharedArrayBuffer !== "function"
  ) {
    note("probe: short Atomics.wait", "no Atomics.wait or SharedArrayBuffer here");
    return;
  }
  if (typeof cpuUsage !== "function") {
    note("probe: short Atomics.wait", "runtime has no process.cpuUsage");
    return;
  }

  const view = new Int32Array(new SharedArrayBuffer(4));
  const busyRatioAt = (timeoutMs: number): number => {
    const rounds = Math.max(8, Math.round(200 / timeoutMs));
    const startedAt = performance.now();
    const before = cpuUsage();
    for (let i = 0; i < rounds; i++) Atomics.wait(view, 0, 0, timeoutMs);
    const delta = cpuUsage(before);
    const wallMs = performance.now() - startedAt;
    return ((delta.user + delta.system) / 1000) / wallMs;
  };

  const atOne = busyRatioAt(1);
  const atTwo = busyRatioAt(2);
  note(
    "probe: short Atomics.wait",
    `busyRatio 1ms=${atOne.toFixed(2)} 2ms=${atTwo.toFixed(2)}` +
      (atOne > 0.5
        ? " -- 1ms timeouts spin here, the parkMs floor is load-bearing"
        : " -- short timeouts sleep, no floor needed"),
  );
};

/**
 * Probe: does a child's `process.send` reach the parent while the child is
 * blocked in a synchronous loop?
 *
 * Bun on Windows queues it until the child yields to its event loop. The
 * worker dispatch loop does not yield on its own, so a completion doorbell
 * rung from inside it would sit unwritten.
 */
const probeBlockedChildIpc = async (): Promise<void> => {
  const bun = (globalThis as typeof globalThis & {
    Bun?: { spawn?: (options: Record<string, unknown>) => unknown };
  }).Bun;
  const execPath = nodeProcess?.execPath;
  if (typeof bun?.spawn !== "function" || execPath === undefined) {
    note("probe: IPC from a blocked child", "needs Bun.spawn, skipped");
    return;
  }

  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = mkdtempSync(join(tmpdir(), "knitting-ipc-"));
  const childPath = join(dir, "blocked-child.mjs");
  const BLOCK_MS = 1500;
  writeFileSync(
    childPath,
    [
      "const view = new Int32Array(new SharedArrayBuffer(4));",
      "process.send({ ring: true });",
      `const until = Date.now() + ${BLOCK_MS};`,
      "while (Date.now() < until) Atomics.wait(view, 0, 0, 1);",
      "process.send({ done: true });",
    ].join("\n"),
  );

  try {
    const ringAt = await new Promise<number>((resolve) => {
      const startedAt = performance.now();
      let settled = false;
      const finish = (value: number) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const child = bun.spawn!({
        cmd: [execPath, childPath],
        serialization: "advanced",
        stdout: "ignore",
        stderr: "ignore",
        ipc: (message: { ring?: boolean }) => {
          if (message?.ring === true) finish(performance.now() - startedAt);
        },
      }) as { kill?: () => void };
      setTimeout(() => {
        finish(Number.POSITIVE_INFINITY);
        child.kill?.();
      }, BLOCK_MS * 3);
    });

    note(
      "probe: IPC from a blocked child",
      `ring arrived after ${
        Number.isFinite(ringAt) ? `${ringAt.toFixed(0)}ms` : "never"
      } while the child blocked ${BLOCK_MS}ms` +
        (ringAt > BLOCK_MS * 0.5
          ? " -- send() does not flush until the child yields, the doorbell hop is load-bearing"
          : " -- send() flushes inline"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Verify that idle workers park instead of spinning. */
const checkIdlePoolDoesNotSpin = async (): Promise<void> => {
  if (typeof cpuUsage !== "function") {
    note("check: idle stealing pool parks", "runtime has no process.cpuUsage");
    return;
  }

  const threads = 3;
  const idleMs = 400;
  const pool = createPool({ threads, host: { steal: true } })({ double });
  try {
    await Promise.all(Array.from({ length: 50 }, (_, i) => pool.call.double(i)));

    const before = cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    const delta = cpuUsage(before);
    const busyRatio = ((delta.user + delta.system) / 1000) / idleMs;

    report(
      busyRatio < 1.5,
      "check: idle stealing pool parks",
      `burned ${
        busyRatio.toFixed(2)
      } cores over ${idleMs}ms with ${threads} idle workers`,
    );
  } finally {
    await pool.shutdown();
  }
};

/**
 * Sequential process-worker calls. The host arms its doorbell between calls,
 * so a completion the worker cannot ring shows up here as a call that never
 * settles -- and it only bites from the second call on.
 */
const checkProcessWorkerCallsSettle = async (): Promise<void> => {
  if (RUNTIME !== "node" && RUNTIME !== "deno" && RUNTIME !== "bun") {
    note("check: process worker calls settle", `not supported on ${RUNTIME}`);
    return;
  }

  const calls = 12;
  const perCallTimeoutMs = 4000;
  const pool = createPool({
    threads: 1,
    worker: { runtime: "process", processRuntime: RUNTIME },
  })({ double });

  try {
    for (let i = 1; i <= calls; i++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        pool.call.double(i),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`call ${i}/${calls} never settled`)),
            perCallTimeoutMs,
          );
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });

      if (result !== i * 2) {
        report(
          false,
          "check: process worker calls settle",
          `call ${i} returned ${result}`,
        );
        return;
      }
    }
    report(
      true,
      "check: process worker calls settle",
      `${calls}/${calls} sequential calls`,
    );
  } catch (error) {
    report(
      false,
      "check: process worker calls settle",
      String((error as Error)?.message ?? error),
    );
  } finally {
    await pool.shutdown();
  }
};

console.log(
  `knitting windows park/wake check -- runtime=${RUNTIME} platform=${platform}`,
);
if (platform !== "win32") {
  console.log(
    "note  not on Windows, so neither quirk applies here; running the checks anyway",
  );
}
console.log("");

probeShortWaitBurnsCpu();
await probeBlockedChildIpc();
console.log("");
await checkIdlePoolDoesNotSpin();
await checkProcessWorkerCallsSettle();

console.log("");
if (failures === 0) {
  console.log("all checks passed");
} else {
  console.log(`${failures} check(s) failed`);
  nodeProcess?.exit?.(1);
}
