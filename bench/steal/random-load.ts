/**
 * Randomised-cost workload: how does stealing behave when task cost is not
 * knowable up front?
 *
 * A balancer that partitions statically (round-robin) must guess. When every
 * task costs the same, guessing is free and static wins on coordination. When
 * costs vary, whichever worker draws the expensive tasks becomes the critical
 * path while the others idle — the case stealing exists for.
 *
 * The workload is generated from a seeded PRNG so every variant runs the exact
 * same task sizes. Payloads are one number each, so this measures scheduling
 * rather than serialization.
 *
 * Env: RL_MODE=plain|steal|per-thread  RL_THREADS  RL_TASKS  RL_SHAPE  RL_REPS
 *      RL_SEED  RL_BASE  RL_G
 * Shapes: flat (all equal) | random (uniform 0.2x..2x) | heavy (90% cheap, 10% 20x)
 */
import { createPool, isMain, task } from "../../knitting.ts";

export const spin = task<number, number>({
  f: (rounds) => {
    let x = 1;
    for (let i = 0; i < rounds; i++) x = (x * 1664525 + 1013904223) >>> 0;
    return x >>> 24;
  },
});

const MODE = process.env.RL_MODE ?? "plain";
const THREADS = Number(process.env.RL_THREADS ?? "4");
const TASKS = Number(process.env.RL_TASKS ?? "400");
const SHAPE = process.env.RL_SHAPE ?? "random";
const REPS = Number(process.env.RL_REPS ?? "5");
const SEED = Number(process.env.RL_SEED ?? "12345");
const BASE = Number(process.env.RL_BASE ?? "200000");
const G = Number(process.env.RL_G ?? "0");

/** mulberry32 — small, seeded, identical across variants. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const buildWorkload = (): number[] => {
  const next = rng(SEED);
  const sizes: number[] = [];
  for (let i = 0; i < TASKS; i++) {
    const r = next();
    if (SHAPE === "flat") sizes.push(BASE);
    else if (SHAPE === "heavy") sizes.push(r < 0.1 ? BASE * 20 : BASE);
    else sizes.push(Math.max(1, Math.floor(BASE * (0.2 + r * 1.8))));
  }
  return sizes;
};

if (isMain) {
  const sizes = buildWorkload();
  const totalRounds = sizes.reduce((a, b) => a + b, 0);

  const options = MODE === "steal"
    ? {
      threads: THREADS,
      host: { steal: true, ...(G > 0 ? { stealRegionLanes: G } : {}) },
    }
    : MODE === "per-thread"
    ? {
      threads: THREADS,
      host: { dispatcher: "per-thread" as const, steal: false },
    }
    : { threads: THREADS, host: { steal: false } };

  const { call, shutdown } = createPool(options as never)({ spin });

  // Warm the pool so worker spin-up is not in the measurement.
  await Promise.all(
    sizes.slice(0, Math.min(64, sizes.length)).map((n) => call.spin(n)),
  );

  const times: number[] = [];
  let sink = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const started = process.hrtime.bigint();
    const out = await Promise.all(sizes.map((n) => call.spin(n)));
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    for (const value of out) sink ^= value;
  }
  await shutdown();

  times.sort((a, b) => a - b);
  console.log(JSON.stringify({
    mode: MODE,
    threads: THREADS,
    shape: SHAPE,
    tasks: TASKS,
    g: G || undefined,
    median_ms: times[Math.floor(times.length / 2)],
    min_ms: times[0],
    rounds_per_ms: totalRounds / times[Math.floor(times.length / 2)]!,
    sink,
  }));
}
