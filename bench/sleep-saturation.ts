import { createPool, isMain, task } from "../knitting.ts";

/**
 * 1000 tasks that each sleep 1000ms. Measures whether an awaiting task holds
 * its worker: the serial floor is (TOTAL / THREADS) * 1s, so ~250s at 4
 * threads. Observed medians are far below it, so awaits do overlap.
 *
 * SLEEP_JITTER varies each duration by +/-J ms. At threads=1 and jitter 0 the
 * wall time is bimodal (2s to 23s); jitter 5 removes the spread entirely.
 */
export const sleepOneSecond = task<number, number>({
  f: async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return value;
  },
});

/** Same shape, but each call picks its own duration in [1000-J, 1000+J]. */
export const sleepJittered = task<[number, number], number>({
  f: async ([value, jitter]) => {
    const ms = 1000 - jitter + Math.floor(Math.random() * (2 * jitter + 1));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return value;
  },
});

if (isMain) {
  const TOTAL = Number(process.env.SLEEP_TOTAL ?? "1000");
  const THREADS = Number(process.env.SLEEP_THREADS ?? "4");

  // Worker spin/park overrides; neither accounts for the jitter-0 spread.
  const spin = process.env.SLEEP_SPIN;
  const park = process.env.SLEEP_PARK;
  const timers = (spin === undefined && park === undefined) ? undefined : {
    ...(spin === undefined ? {} : { spinMicroseconds: Number(spin) }),
    ...(park === undefined ? {} : { parkMs: Number(park) }),
  };

  const pool = createPool({
    threads: THREADS,
    ...(timers === undefined ? {} : { worker: { timers } }),
  })({ sleepOneSecond, sleepJittered });

  // Boot every lane before timing, so worker spawn is not billed to the run.
  await Promise.all(
    Array.from({ length: THREADS }, () => pool.call.sleepOneSecond(-1)),
  );

  const started = performance.now();
  let firstSettleAt = 0;
  let settled = 0;
  const settleAt = new Float64Array(TOTAL);

  const JITTER = Number(process.env.SLEEP_JITTER ?? "0");
  const fire = (i: number) =>
    JITTER > 0
      ? pool.call.sleepJittered([i, JITTER])
      : pool.call.sleepOneSecond(i);

  const results = await Promise.all(
    Array.from({ length: TOTAL }, (_, i) =>
      fire(i).then((value) => {
        const at = performance.now() - started;
        settleAt[i] = at;
        if (settled++ === 0) firstSettleAt = at;
        return value;
      })),
  );

  const wall = performance.now() - started;

  let mismatched = 0;
  for (let i = 0; i < TOTAL; i++) if (results[i] !== i) mismatched++;

  const serialFloor = (TOTAL / THREADS) * 1000;

  // How many settled in each 1s bucket: the wave structure.
  const waves: Record<string, number> = {};
  for (let i = 0; i < TOTAL; i++) {
    const b = Math.floor(settleAt[i] / 1000);
    const key = `${b}-${b + 1}s`;
    waves[key] = (waves[key] ?? 0) + 1;
  }

  console.log(JSON.stringify(
    {
      waves,
      total: TOTAL,
      threads: THREADS,
      jitter_ms: Number(process.env.SLEEP_JITTER ?? "0"),
      wall_ms: +wall.toFixed(0),
      first_settle_ms: +firstSettleAt.toFixed(0),
      mismatched,
      effective_concurrency: +(TOTAL / (wall / 1000)).toFixed(1),
      serial_floor_ms: serialFloor,
    },
    null,
    2,
  ));

  await pool.shutdown();
}
