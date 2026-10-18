import { readFileSync } from "node:fs";
import childProcess from "node:child_process";
import { threadId } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { createPool, isMain, task } from "../knitting.ts";
import { RUNTIME } from "../src/common/runtime.ts";

// Admission uses high-resolution epoch stamps because Bun/Deno
// hrtime origins can differ between processes. Durations use local hrtime.
// PARK_THREADS=2 PARK_STEAL=true node --no-warnings \
//   --experimental-transform-types bench/process-async-park.ts
const nowUs = () => Number(process.hrtime.bigint()) / 1000;
const epochUs = () => (performance.timeOrigin + performance.now()) * 1000;
let activeHolds = 0;
let polls = 0;
let observing = false;

export const hold = task<number, null | Promise<null>>({
  f: (pid) => {
    if (pid !== process.pid) return null;
    if (!observing) {
      observing = true;
      const original = globalThis.setTimeout;
      globalThis.setTimeout = ((callback, ms, ...args) => {
        if (typeof ms === "number" && ms > 0 && ms <= 10) ++polls;
        return original(callback, ms, ...args);
      }) as typeof setTimeout;
    }
    ++activeHolds;
    return new Promise((resolve) =>
      setTimeout(() => {
        --activeHolds;
        resolve(null);
      }, 120_000)
    );
  },
});

export const probe = task<void, { pid: number; thread: number; active: number; polls: number }>(
  {
    f: () => {
      // A tiny amount of work lets every stealing consumer claim a probe.
      const until = nowUs() + 100;
      while (nowUs() < until) {}
      return { pid: process.pid, thread: threadId, active: activeHolds, polls };
    },
  },
);

export const mark = task<number, number>({ f: (started) => epochUs() - started });
export const sync = task<number, number>({ f: (value) => value + 1 });
export const immediate = task<number, Promise<number>>({
  f: async (value) => value + 1,
});
export const awaited = task<number, Promise<number>>({
  f: async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return value + 1;
  },
});

const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  ]!;
};
const summary = (values: number[]) => ({
  p50_us: percentile(values, 0.5),
  p99_us: percentile(values, 0.99),
  max_us: Math.max(...values),
});

if (isMain) {
  const run = async () => {
    const threads = Number(process.env.PARK_THREADS ?? 1);
    const steal = process.env.PARK_STEAL === "true";
    const samples = Number(process.env.PARK_SAMPLES ?? 256);
    const syncCalls = Number(process.env.PARK_SYNC_CALLS ?? 524_288);
    const idleMs = Number(process.env.PARK_IDLE_MS ?? 1000);
    const workerMode = process.env.PARK_WORKER ?? "process";
    const processRuntime = process.env.PARK_PROCESS_RUNTIME ?? RUNTIME;
    if (!["node", "bun", "deno"].includes(processRuntime)) {
      throw new Error("PARK_PROCESS_RUNTIME must be node, bun or deno");
    }
    if (process.env.PARK_ONLY_SYNC !== "true" && workerMode !== "process") {
      throw new Error("Latency/idle sampling requires process workers");
    }
    const taskKind = process.env.PARK_TASK ?? "sync";
    if (!["sync", "immediate", "awaited"].includes(taskKind)) {
      throw new Error("PARK_TASK must be sync, immediate or awaited");
    }
    const cap = process.env.PARK_MAX_AWAITING;
    const maxAwaitingTasks = cap === undefined ? undefined
      : cap === "auto" ? "auto" : Number(cap);
    const workerCpus = (process.env.PARK_WORKER_CPUS ?? "").split(",")
      .filter(Boolean).map(Number);
    const linux = process.platform === "linux";
    if (workerCpus.length > 0 && !linux) {
      throw new Error("PARK_WORKER_CPUS is only supported on Linux");
    }
    if (
      workerCpus.length !== 0 && (workerCpus.length < threads ||
        new Set(workerCpus).size !== workerCpus.length ||
        workerCpus.some((cpu) => !Number.isInteger(cpu) || cpu < 0))
    ) {
      throw new Error("PARK_WORKER_CPUS must list at least one CPU per worker");
    }
    const pool = createPool({
      threads,
      host: { steal, doorbell: true },
      worker: {
        ...(workerMode === "process" ? {
          runtime: "process" as const,
          processRuntime: processRuntime as "node" | "bun" | "deno",
        } : {}),
        maxAwaitingTasks,
        timers: { spinMicroseconds: 0, parkMs: 1000 },
      },
    })({ hold, probe, mark, sync, immediate, awaited });
    const call = taskKind === "awaited" ? pool.call.awaited
      : taskKind === "immediate" ? pool.call.immediate : pool.call.sync;

    const collect = async () => {
      const seen = new Map<number, { pid: number; active: number; polls: number }>();
      const deadline = performance.now() + 10_000;
      while (seen.size < threads) {
        const reports = await Promise.all(Array.from(
          { length: Math.max(32, threads * 8) },
          () => pool.call.probe(),
        ));
        for (const { thread, ...stats } of reports) {
          seen.set(workerMode === "process" ? stats.pid : thread, stats);
        }
        if (performance.now() > deadline) {
          throw new Error("could not observe every worker");
        }
      }
      return seen;
    };
    const batch = async (count: number) => {
      for (let start = 0; start < count; start += 64) {
        const out = await Promise.all(Array.from(
          { length: Math.min(64, count - start) },
          (_, i) => call(i),
        ));
        if (out.some((value, i) => value !== i + 1)) {
          throw new Error("wrong sync result");
        }
      }
    };
    const cpuNs = (pids: number[]) => linux
      ? pids.reduce(
        (sum, pid) => sum + Number(
          readFileSync(`/proc/${pid}/schedstat`, "utf8").split(" ")[0],
        ),
        0,
      )
      : undefined;
    const held: Promise<unknown>[] = [];
    let closed = false;
    const watchdog = setTimeout(() => {
      throw new Error("benchmark timed out");
    }, 90_000);
    try {
      const workers = await collect();
      if (workerMode === "process" && workerCpus.length > 0) {
        // Pin after boot so native Bun.spawn/Deno.Command and Node-compatible
        // spawn paths receive the same affinity without changing their IPC.
        let index = 0;
        for (const { pid } of workers.values()) {
          const pinned = childProcess.spawnSync(
            "taskset", ["-pc", String(workerCpus[index++]!), String(pid)],
            { encoding: "utf8" },
          );
          if (pinned.status !== 0) throw new Error(`worker affinity failed: ${pinned.stderr}`);
        }
      }
      const readAffinity = (pid: number | "self") => linux
        ? readFileSync(`/proc/${pid}/status`, "utf8")
          .match(/^Cpus_allowed_list:\s*(.+)$/m)![1]!.trim()
        : undefined;
      const workerAffinity = linux
        ? [...workers.values()].map(({ pid }) => readAffinity(pid))
        : undefined;
      if (
        workerMode === "process" && workerCpus.length > 0 &&
        [...workerAffinity].sort().join("|") !==
          workerCpus.slice(0, threads).map(String).sort().join("|")
      ) {
        throw new Error("worker CPU affinity does not match PARK_WORKER_CPUS");
      }
      const affinity = linux
        ? { host: readAffinity("self"), workers: workerAffinity }
        : undefined;
      const warmStarted = nowUs();
      do {
        await batch(Number(process.env.PARK_WARMUP_CALLS ?? 65_536));
      } while (
        nowUs() - warmStarted <
          Number(process.env.PARK_SYNC_WARMUP_MS ?? 0) * 1000
      );
      const syncStarted = nowUs();
      let measuredSyncCalls = 0;
      do {
        await batch(syncCalls);
        measuredSyncCalls += syncCalls;
      } while (
        nowUs() - syncStarted < Number(process.env.PARK_SYNC_MIN_MS ?? 0) * 1000
      );
      const syncUs = nowUs() - syncStarted;
      const syncResult = {
        affinity,
        host_runtime: RUNTIME,
        worker_mode: workerMode,
        process_runtime: workerMode === "process" ? processRuntime : undefined,
        task: taskKind,
        max_awaiting: maxAwaitingTasks,
        threads,
        steal,
        sync_calls: measuredSyncCalls,
        sync_calls_per_second: measuredSyncCalls / (syncUs / 1e6),
        sync_wall_ms: syncUs / 1000,
        sync_warmup_ms: (syncStarted - warmStarted) / 1000,
      };
      if (process.env.PARK_ONLY_SYNC === "true") {
        await pool.shutdown();
        closed = true;
        return syncResult;
      }

      let stats = await collect();
      const holdDeadline = performance.now() + 10_000;
      while ([...stats.values()].some(({ active }) => active === 0)) {
        for (const [pid, { active }] of stats) {
          if (active !== 0) continue;
          for (let attempt = 0; attempt < threads * 4; attempt++) {
            held.push(pool.call.hold(pid).catch(() => null));
          }
        }
        stats = await collect();
        if (performance.now() > holdDeadline) {
          throw new Error("not every worker holds an await");
        }
      }
      // Warm this distinct async-park path before sampling its latency.
      for (let i = 0; i < 128; i++) await pool.call.mark(epochUs());
      await delay(50);
      const beforeStats = await collect();
      const pids = [...workers.keys()];
      const cpuBefore = cpuNs(pids);
      const idleStarted = nowUs();
      await delay(idleMs);
      const idleWallUs = nowUs() - idleStarted;
      const cpuAfter = cpuNs(pids);
      const idleCpuNs = cpuBefore === undefined || cpuAfter === undefined
        ? undefined
        : cpuAfter - cpuBefore;
      const afterStats = await collect();
      const idlePolls = [...afterStats].reduce(
        (sum, [pid, stat]) => sum + stat.polls - beforeStats.get(pid)!.polls,
        0,
      );

      const admission: number[] = [];
      const roundTrip: number[] = [];
      let random = 0x5eed;
      for (let i = 0; i < samples; i++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        // Vary arrival phase relative to the old 10ms poll; let the new worker
        // return to async park between samples.
        await delay(
          Number(process.env.PARK_GAP_MIN_MS ?? 1) +
            random % Number(process.env.PARK_GAP_SPAN_MS ?? 15),
        );
        const started = nowUs();
        const taskStartedUs = await pool.call.mark(epochUs());
        const elapsedUs = nowUs() - started;
        if (!Number.isFinite(taskStartedUs) || taskStartedUs < 0 ||
          taskStartedUs > elapsedUs) {
          throw new Error(`invalid cross-process admission clock: ${taskStartedUs}us / ${elapsedUs}us round trip`);
        }
        admission.push(taskStartedUs);
        roundTrip.push(elapsedUs);
      }
      const stopStarted = nowUs();
      await pool.shutdown();
      closed = true;
      const shutdownUs = nowUs() - stopStarted;
      await Promise.all(held);
      return {
        ...syncResult,
        samples,
        arrival_gap_min_ms: Number(process.env.PARK_GAP_MIN_MS ?? 1),
        arrival_gap_span_ms: Number(process.env.PARK_GAP_SPAN_MS ?? 15),
        submit_to_task_start: summary(admission),
        round_trip: summary(roundTrip),
        idle_wall_ms: idleWallUs / 1000,
        worker_main_thread_cpu_ms: idleCpuNs === undefined
          ? undefined
          : idleCpuNs / 1e6,
        worker_main_thread_cpu_percent_one_core: idleCpuNs === undefined
          ? undefined
          : idleCpuNs / (idleWallUs * 1000) * 100,
        idle_backoff_timers_per_second: idlePolls / (idleWallUs / 1e6),
        shutdown_us: shutdownUs,
        admission_samples_us: admission,
        round_trip_samples_us: roundTrip,
      };
    } finally {
      clearTimeout(watchdog);
      if (!closed) await pool.shutdown();
    }
  };
  console.log(JSON.stringify(await run()));
}
