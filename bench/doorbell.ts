/** Compare polling, native doorbells, and process completion doorbells.
 * Configure the mode with `DB_MODE`, `DB_TOPOLOGY`, and `DB_WORKER`.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createPool, isMain, task } from "../knitting.ts";
import { processWorkerUsesIpc } from "../src/runtime/process-worker.ts";
import { RUNTIME } from "../src/common/runtime.ts";
import { taskToHostMicros } from "./util/doorbell-clock.ts";
import { createNodeCompletionDoorbell } from "../src/runtime/node-doorbell.ts";

export const mixed = task<number, number>({
  f: (input) => {
    const shape = input & 3;
    const rounds = BASE *
      (shape === 0 ? 1 : shape === 1 ? 2 : shape === 2 ? 4 : 8);
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
 * task-finish-to-host latency from request pickup and task execution. This
 * includes serialization and time waiting to publish the return frame. The low bit
 * retains an observable piece of the mixed workload, preventing the loop from
 * becoming dead code.
 */
export const timedMixed = task<number, number>({
  f: (input) => {
    const shape = input & 3;
    const rounds = BASE *
      (shape === 0 ? 1 : shape === 1 ? 2 : shape === 2 ? 4 : 8);
    let value = (input ^ 0x9e3779b9) >>> 0;
    for (let index = 0; index < rounds; index++) {
      value = (value * 1664525 + 1013904223) >>> 0;
    }
    return Math.round((performance.timeOrigin + performance.now()) * 100) * 2 +
      (value & 1);
  },
});

const MODE = process.env.DB_MODE ?? "poll";
const TOPOLOGY = process.env.DB_TOPOLOGY ?? "steal";
const integerEnv = (name: string, fallback: number, minimum = 1): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
};
const THREADS = integerEnv("DB_THREADS", 4);
const CONCURRENCY = integerEnv("DB_CONCURRENCY", 32);
const TASKS = integerEnv("DB_TASKS", 3200);
const REPS = integerEnv("DB_REPS", 3);
const WARMUP_REPS = integerEnv("DB_WARMUP_REPS", 1);
const BASE = integerEnv("DB_BASE", 12000);
const STALL_FREE_LOOPS = integerEnv("DB_STALL_FREE_LOOPS", 16, 0);
const NATIVE_DOORBELL = process.env.DB_NATIVE === "1";
/** Region width; zero uses the pool default. */
const REGION_LANES = integerEnv("DB_G", 0, 0);
const WORKER_MODE = process.env.DB_WORKER === "process" ? "process" : "thread";
const PROCESS_RUNTIME: "node" | "bun" | "deno" =
  process.env.DB_PROCESS_RUNTIME === "bun"
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

const threadCpuUsage = (process as typeof process & {
  threadCpuUsage?: () => { user: number; system: number };
}).threadCpuUsage;
// /proc counters use the system's USER_HZ, not milliseconds. Resolve it before
// the timed run rather than assuming every Linux machine uses 100Hz.
const clockTicks = !isMain || process.platform !== "linux" ||
    typeof threadCpuUsage === "function"
  ? undefined
  : (() => {
    try {
      const result = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
      const ticks = Number(result.stdout);
      return result.status === 0 && ticks > 0 ? ticks : undefined;
    } catch {
      return undefined;
    }
  })();
const cpuScope =
  typeof threadCpuUsage === "function" || clockTicks !== undefined
    ? "host-thread"
    : WORKER_MODE === "process"
    ? "host-process"
    : undefined;

const mainThreadCpuMs = (): number | undefined => {
  if (typeof threadCpuUsage === "function") {
    const usage = threadCpuUsage();
    return (usage.user + usage.system) / 1_000;
  }
  if (cpuScope === "host-process") {
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
  if (clockTicks === undefined) return undefined;
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]);
    return ticks * 1000 / clockTicks;
  } catch {
    return undefined;
  }
};

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ]!;
};

const epochMillis = (): number => performance.timeOrigin + performance.now();

if (isMain) {
  if (!["poll", "doorbell"].includes(MODE)) {
    throw new Error("DB_MODE must be poll or doorbell");
  }
  if (
    process.env.DB_WORKER !== undefined &&
    !["thread", "process"].includes(process.env.DB_WORKER)
  ) {
    throw new Error("DB_WORKER must be thread or process");
  }
  if (
    process.env.DB_PROCESS_RUNTIME !== undefined &&
    !["node", "bun", "deno"].includes(process.env.DB_PROCESS_RUNTIME)
  ) {
    throw new Error("DB_PROCESS_RUNTIME must be node, bun, or deno");
  }
  if (
    WORKER_MODE === "process" && MODE === "doorbell" &&
    !processWorkerUsesIpc({ processRuntime: PROCESS_RUNTIME })
  ) {
    throw new Error(
      `No IPC completion doorbell for ${RUNTIME} host -> ${PROCESS_RUNTIME} worker`,
    );
  }
  if (
    ![
      "steal",
      "per-thread",
      "serial-channel",
    ].includes(TOPOLOGY)
  ) {
    throw new Error(`Unknown DB_TOPOLOGY: ${TOPOLOGY}`);
  }
  if (NATIVE_DOORBELL) {
    if (RUNTIME !== "node" || WORKER_MODE !== "thread" || MODE !== "doorbell") {
      throw new Error(
        "DB_NATIVE=1 requires a Node host, thread workers, and DB_MODE=doorbell",
      );
    }
    const probe = createNodeCompletionDoorbell(() => {});
    if (probe === undefined) {
      throw new Error("requested native Node doorbell addon is unavailable");
    }
    probe.close();
  }

  const inputs = makeInputs();
  const expected = WORKER_MODE === "thread"
    ? new Map(inputs.map((input) => [input, mixed.f(input)]))
    : undefined;
  const host = {
    doorbell: MODE === "doorbell",
    nativeDoorbell: WORKER_MODE === "thread" && NATIVE_DOORBELL,
    stallFreeLoops: STALL_FREE_LOOPS,
    ...(REGION_LANES > 0 ? { stealRegionLanes: REGION_LANES } : {}),
    ...(TOPOLOGY === "steal" ? { steal: true } : {
      steal: false,
      dispatcher: TOPOLOGY as "per-thread" | "serial-channel",
    }),
  };
  const worker = WORKER_MODE === "process"
    ? { runtime: "process" as const, processRuntime: PROCESS_RUNTIME }
    : undefined;
  const pool = createPool({
    threads: THREADS,
    host,
    worker,
    // Match worker permissions for native/portable Node thread comparisons.
    // The strict default would silently disable the native notifier.
    ...(RUNTIME === "node" && WORKER_MODE === "thread"
      ? {
        permission: {
          mode: "strict" as const,
          allowImport: true,
          node: { allowAddons: true },
        },
      }
      : {}),
  })({
    mixed,
    timedMixed,
  });
  const call = WORKER_MODE === "process"
    ? pool.call.timedMixed
    : pool.call.mixed;

  try {
    // Warm the representative workload, including host and worker JIT paths.
    // One call at concurrency=1 only boots the worker and leaves JIT startup
    // inside the measurements.
    for (let rep = 0; rep < WARMUP_REPS; rep++) {
      for (let offset = 0; offset < inputs.length; offset += CONCURRENCY) {
        await Promise.all(
          inputs.slice(offset, offset + CONCURRENCY).map((value) =>
            call(value)
          ),
        );
      }
    }

    const latencies: number[] = [];
    const completionDeliveryMicros: number[] = [];
    let invalidClockSamples = 0;
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
              const deliveryMicros = taskToHostMicros(result, epochMillis());
              // Rounding the worker timestamp to 10us can make an immediate
              // return slightly negative. Keep every nonnegative slow sample:
              // filtering >=1s would hide exactly the watchdog stalls we need.
              if (deliveryMicros !== undefined) {
                completionDeliveryMicros.push(deliveryMicros);
              } else invalidClockSamples++;
              const rounds = BASE * (1 << (value & 3));
              if ((result & 1) !== ((value ^ 0x9e3779b9 ^ rounds) & 1)) {
                throw new Error("timed workload checksum mismatch");
              }
              sink ^= result & 1;
            } else {
              if (result !== expected!.get(value)) {
                throw new Error("workload checksum mismatch");
              }
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
      runtime: RUNTIME,
      worker_mode: WORKER_MODE,
      process_runtime: WORKER_MODE === "process" ? PROCESS_RUNTIME : undefined,
      topology: TOPOLOGY,
      threads: THREADS,
      concurrency: CONCURRENCY,
      tasks_per_rep: TASKS,
      reps: REPS,
      warmup_reps: WARMUP_REPS,
      base_rounds: BASE,
      stall_free_loops: STALL_FREE_LOOPS,
      region_lanes: REGION_LANES > 0 ? REGION_LANES : undefined,
      native_doorbell: WORKER_MODE === "thread" && NATIVE_DOORBELL,
      median_ms: +medianWallMs.toFixed(3),
      p50_latency_ms: +percentile(latencies, 0.50).toFixed(3),
      p99_latency_ms: +percentile(latencies, 0.99).toFixed(3),
      task_to_host_samples: completionDeliveryMicros.length,
      invalid_clock_samples: invalidClockSamples,
      task_to_host_ge_1s: completionDeliveryMicros.filter((value) =>
        value >= 1_000_000
      ).length,
      p50_task_to_host_us: completionDeliveryMicros.length === 0
        ? undefined
        : +percentile(completionDeliveryMicros, 0.50).toFixed(1),
      p99_task_to_host_us: completionDeliveryMicros.length === 0
        ? undefined
        : +percentile(completionDeliveryMicros, 0.99).toFixed(1),
      max_task_to_host_us: completionDeliveryMicros.length === 0
        ? undefined
        : +completionDeliveryMicros.reduce(
          (max, value) => Math.max(max, value),
          0,
        ).toFixed(1),
      ops_per_second: +(TASKS * REPS / (elapsedMs / 1000)).toFixed(1),
      host_cpu_ms: cpuMs === undefined ? undefined : +cpuMs.toFixed(3),
      host_cpu_scope: cpuScope,
      host_cpu_us_per_op: cpuMs === undefined
        ? undefined
        : +(cpuMs * 1000 / (TASKS * REPS)).toFixed(3),
      host_busy: cpuMs === undefined
        ? undefined
        : +(cpuMs / elapsedMs).toFixed(3),
      sink,
    }));
  } finally {
    await pool.shutdown();
  }
}
