/**
 * Host completion-pump A/B benchmark.
 *
 * Run one variant at a time so the worker pools do not compete for cores:
 *
 *   DB_MODE=poll     DB_TOPOLOGY=steal DB_THREADS=4 bun bench/doorbell.ts
 *   DB_MODE=doorbell DB_TOPOLOGY=steal DB_THREADS=4 bun bench/doorbell.ts
 *   DB_MODE=doorbell DB_NATIVE=1 DB_TOPOLOGY=per-thread DB_THREADS=1 bun bench/doorbell.ts
 *   DB_MODE=doorbell DB_WORKER=process DB_PROCESS_RUNTIME=node DB_THREADS=1 bun bench/doorbell.ts
 *
 * DB_TOPOLOGY is steal, per-thread, or serial-channel. The workload and seed
 * are identical between modes. DB_NATIVE opts into the experimental Node/Bun
 * native callback bridge for thread workers. DB_WORKER=process measures the
 * process IPC completion doorbell instead. Results include throughput,
 * completion latency, and host CPU (`process.cpuUsage`, with a /proc fallback).
 */
import { readFileSync } from "node:fs";
import { createPool, isMain, task } from "../knitting.ts";

export const mixed = task<number, number>({
  f: (input) => {
    const shape = input & 3;
    const rounds = BASE * (shape === 0 ? 1 : shape === 1 ? 2 : shape === 2 ? 4 : 8);
    let value = (input ^ 0x9e3779b9) >>> 0;
    for (let index = 0; index < rounds; index++) {
      value = (value * 1664525 + 1013904223) >>> 0;
    }
    return value;
  },
});

/**
 * `performance.timeOrigin + performance.now()` is a high-resolution shared
 * epoch on Node and Bun. This lets the process-worker benchmark separate
 * completion delivery from request pickup and task execution. The low bit
 * retains an observable piece of the mixed workload, preventing the loop from
 * becoming dead code.
 */
export const timedMixed = task<number, number>({
  f: (input) => {
    const shape = input & 3;
    const rounds = BASE * (shape === 0 ? 1 : shape === 1 ? 2 : shape === 2 ? 4 : 8);
    let value = (input ^ 0x9e3779b9) >>> 0;
    for (let index = 0; index < rounds; index++) {
      value = (value * 1664525 + 1013904223) >>> 0;
    }
    return Math.round((performance.timeOrigin + performance.now()) * 100) * 2 +
      (value & 1);
  },
});

const MODE = process.env.DB_MODE === "doorbell" ? "doorbell" : "poll";
const TOPOLOGY = process.env.DB_TOPOLOGY ?? "steal";
const THREADS = Math.max(1, Number(process.env.DB_THREADS ?? "4"));
const CONCURRENCY = Math.max(1, Number(process.env.DB_CONCURRENCY ?? "32"));
const TASKS = Math.max(CONCURRENCY, Number(process.env.DB_TASKS ?? "3200"));
const REPS = Math.max(1, Number(process.env.DB_REPS ?? "3"));
const BASE = Math.max(1, Number(process.env.DB_BASE ?? "12000"));
const STALL_FREE_LOOPS = Math.max(
  0,
  Number(process.env.DB_STALL_FREE_LOOPS ?? "16"),
);
const NATIVE_DOORBELL = process.env.DB_NATIVE === "1";
/** Region width `g`; 0 keeps the pool's default for the worker count. */
const REGION_LANES = Math.max(0, Number(process.env.DB_G ?? "0"));
const WORKER_MODE = process.env.DB_WORKER === "process" ? "process" : "thread";
const PROCESS_RUNTIME: "node" | "bun" | "deno" = process.env.DB_PROCESS_RUNTIME === "bun"
  ? "bun"
  : process.env.DB_PROCESS_RUNTIME === "deno"
  ? "deno"
  : "node";

const makeInputs = (): number[] => {
  let state = 0x12345678;
  const values: number[] = [];
  for (let index = 0; index < TASKS; index++) {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    values.push((value ^ (value >>> 14)) >>> 0);
  }
  return values;
};

const mainThreadCpuMs = (): number | undefined => {
  if (WORKER_MODE === "process") {
    try {
      const cpuUsage = (process as typeof process & {
        cpuUsage?: () => { user: number; system: number };
      }).cpuUsage;
      if (typeof cpuUsage === "function") {
        const usage = cpuUsage();
        return (usage.user + usage.system) / 1_000;
      }
    } catch {
      // Use the Linux main-thread counter below when the compatibility layer
      // does not expose process.cpuUsage().
    }
  }
  const pid = process.pid;
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]);
    return ticks * 10;
  } catch {
    return undefined;
  }
};

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};

const epochMillis = (): number => performance.timeOrigin + performance.now();

if (isMain) {
  if (![
    "steal",
    "per-thread",
    "serial-channel",
  ].includes(TOPOLOGY)) {
    throw new Error(`Unknown DB_TOPOLOGY: ${TOPOLOGY}`);
  }

  const inputs = makeInputs();
  const host = {
    doorbell: MODE === "doorbell",
    nativeDoorbell: WORKER_MODE === "thread" && NATIVE_DOORBELL,
    stallFreeLoops: STALL_FREE_LOOPS,
    ...(REGION_LANES > 0 ? { stealRegionLanes: REGION_LANES } : {}),
    ...(TOPOLOGY === "steal"
      ? { steal: true }
      : { steal: false, dispatcher: TOPOLOGY as "per-thread" | "serial-channel" }),
  };
  const worker = WORKER_MODE === "process"
    ? { runtime: "process" as const, processRuntime: PROCESS_RUNTIME }
    : undefined;
  const pool = createPool({ threads: THREADS, host, worker })({ mixed, timedMixed });
  const call = WORKER_MODE === "process"
    ? pool.call.timedMixed
    : pool.call.mixed;

  try {
    await Promise.all(inputs.slice(0, CONCURRENCY).map((value) => call(value)));

    const latencies: number[] = [];
    const completionDeliveryMicros: number[] = [];
    const wallTimes: number[] = [];
    let sink = 0;
    const cpuBefore = mainThreadCpuMs();
    const wallBefore = performance.now();

    for (let rep = 0; rep < REPS; rep++) {
      const started = performance.now();
      for (let offset = 0; offset < inputs.length; offset += CONCURRENCY) {
        const batch = inputs.slice(offset, offset + CONCURRENCY);
        const batchStarted = performance.now();
        const pending = batch.map((value) =>
          call(value).then((result) => {
            latencies.push(performance.now() - batchStarted);
            if (WORKER_MODE === "process") {
              const workerPublishedAt = Math.floor(result / 2) / 100;
              const deliveryMicros = (epochMillis() - workerPublishedAt) * 1_000;
              // Guard the output if a host/child pair exposes incompatible
              // clocks. Node and Bun use the same Unix-epoch time origin.
              if (deliveryMicros >= 0 && deliveryMicros < 1_000_000) {
                completionDeliveryMicros.push(deliveryMicros);
              }
              sink ^= result & 1;
            } else {
              sink ^= result;
            }
          })
        );
        await Promise.all(pending);
      }
      wallTimes.push(performance.now() - started);
    }

    const elapsedMs = performance.now() - wallBefore;
    const cpuAfter = mainThreadCpuMs();
    const cpuMs = cpuBefore === undefined || cpuAfter === undefined
      ? undefined
      : cpuAfter - cpuBefore;
    const medianWallMs = percentile(wallTimes, 0.5);

    console.log(JSON.stringify({
      mode: MODE,
      worker_mode: WORKER_MODE,
      process_runtime: WORKER_MODE === "process" ? PROCESS_RUNTIME : undefined,
      topology: TOPOLOGY,
      threads: THREADS,
      concurrency: CONCURRENCY,
      tasks_per_rep: TASKS,
      reps: REPS,
      base_rounds: BASE,
      stall_free_loops: STALL_FREE_LOOPS,
      region_lanes: REGION_LANES > 0 ? REGION_LANES : undefined,
      native_doorbell: WORKER_MODE === "thread" && NATIVE_DOORBELL,
      median_ms: +medianWallMs.toFixed(3),
      p50_latency_ms: +percentile(latencies, 0.50).toFixed(3),
      p99_latency_ms: +percentile(latencies, 0.99).toFixed(3),
      p50_completion_delivery_us: completionDeliveryMicros.length === 0
        ? undefined
        : +percentile(completionDeliveryMicros, 0.50).toFixed(1),
      p99_completion_delivery_us: completionDeliveryMicros.length === 0
        ? undefined
        : +percentile(completionDeliveryMicros, 0.99).toFixed(1),
      ops_per_second: +(TASKS * REPS / (elapsedMs / 1000)).toFixed(1),
      host_cpu_ms: cpuMs === undefined ? undefined : +cpuMs.toFixed(3),
      host_cpu_us_per_op: cpuMs === undefined
        ? undefined
        : +(cpuMs * 1000 / (TASKS * REPS)).toFixed(3),
      host_busy: cpuMs === undefined ? undefined : +(cpuMs / elapsedMs).toFixed(3),
      sink,
    }));
  } finally {
    await pool.shutdown();
  }
}
