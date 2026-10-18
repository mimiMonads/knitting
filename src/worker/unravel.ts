import { RUNTIME } from "../common/runtime.ts";
import type { UnravelOptions } from "../types.ts";
import { threadCpuClock } from "./thread-cpu-clock.ts";

/** The dispatcher's view of automatic admission (maxAwaitingTasks: "auto"). */
export type AdmissionController = {
  getLimit: () => number;
  /** Reads the busy clock before work that may not be async task service. */
  start: () => number;
  /** Returns a per-task token, which the dispatcher hands back to settle. */
  asyncStarted: () => number;
  /** Work since `start` was not async task service. */
  exclude: (startedBusy: number) => void;
  canProbe: () => boolean;
  /** At the cap: grow toward the visible share of queued plus held work. */
  coldGrow: (backlog: number, workers: number, totalOwned?: number) => boolean;
  settle: (awaiting: number, token?: number) => number;
};

export const resolveUnravelOptions = (options?: UnravelOptions) => {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    throw new TypeError("worker.unravel must be an options object");
  }
  const maxTasks = options?.maxTasks ?? 256;
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 65_536) {
    throw new TypeError("worker.unravel.maxTasks must be an integer from 1 to 65536");
  }
  const minTasks = options?.minTasks ?? 1;
  if (!Number.isInteger(minTasks) || minTasks < 1 || minTasks > maxTasks) {
    throw new TypeError("worker.unravel.minTasks must be an integer from 1 to maxTasks");
  }
  const initialTasks = options?.initialTasks ?? Math.min(maxTasks, Math.max(2, minTasks));
  if (!Number.isInteger(initialTasks) || initialTasks < minTasks || initialTasks > maxTasks) {
    throw new TypeError("worker.unravel.initialTasks must be an integer from minTasks to maxTasks");
  }
  const growth = options?.growth ?? 2;
  if (!Number.isInteger(growth) || growth === 1 || growth < 0 || growth > 1024) {
    throw new TypeError("worker.unravel.growth must be 0 or an integer from 2 to 1024");
  }
  const tickMs = options?.tickMs ?? 1;
  if (!Number.isFinite(tickMs) || tickMs <= 0) {
    throw new TypeError("worker.unravel.tickMs must be finite and positive");
  }
  const epsilon = options?.epsilon ?? .01;
  if (!Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 1) {
    throw new TypeError("worker.unravel.epsilon must be finite and between 0 and 1");
  }
  const ceiling = options?.ceiling ?? true;
  const floor = options?.floor ?? true;
  if (typeof ceiling !== "boolean" || typeof floor !== "boolean") {
    throw new TypeError("worker.unravel.ceiling and worker.unravel.floor must be booleans");
  }
  return { maxTasks, minTasks, initialTasks, growth, tickMs, epsilon, ceiling, floor };
};

/** A busy clock in milliseconds; `threadCpu` marks a thread CPU clock. */
export type BusyClock = { read: () => number; threadCpu: boolean };

let resolvedCpuClock: BusyClock | null | undefined;

/**
 * Busy time of this thread, in milliseconds; never process-wide CPU.
 *
 * Idle is wall time minus busy time, so the busy clock must resolve the gaps
 * between dispatcher events. Node workers use event-loop active time, which
 * has nanosecond resolution and costs less to read. While async tasks are
 * pending the dispatcher never blocks, so active time is time spent running
 * JS. Bun's eventLoopUtilization() reads zero, so Bun uses a thread CPU clock
 * (see threadCpuClock), resolved once per thread.
 */
export const workerCpuClock = (): BusyClock => {
  const elu = (globalThis.performance as {
    eventLoopUtilization?: () => { active: number };
  } | undefined)?.eventLoopUtilization;
  if (RUNTIME === "node" && typeof elu === "function") {
    const read = elu.bind(globalThis.performance);
    return { read: () => read().active, threadCpu: false };
  }
  if (resolvedCpuClock === undefined) {
    const read = threadCpuClock();
    resolvedCpuClock = read === undefined ? null : { read, threadCpu: true };
  }
  if (resolvedCpuClock === null) {
    throw new Error(
      "Unravel requires a fine-grained thread CPU clock in the worker runtime",
    );
  }
  return resolvedCpuClock;
};

/** Whether this runtime has a busy clock Unravel can use. */
export const hasWorkerCpuClock = () => {
  try {
    workerCpuClock();
    return true;
  } catch {
    return false;
  }
};

/** Int32 words per 64-byte line: the pool header, then one line per worker. */
export const UNRAVEL_SHARED_STRIDE = 16;
export const unravelSharedBytes = (workers: number) => (workers + 1) * UNRAVEL_SHARED_STRIDE * 4;
/** Header Int32 word set once any worker has published an estimate. */
const WARM = 2;
/** A worker line: W and C (Float64 words 0 and 1), then its weight (Int32 word 4). */
const WEIGHT = 4;
/** A worker's estimate weighs as many settles as it has seen, up to this. */
const MAX_WEIGHT = 8;

/**
 * Pool-wide Unravel state in one SharedArrayBuffer. The header holds the cold
 * clock (BigInt64 word 0, microseconds since the epoch plus one, 0 until set)
 * and the warm flag. Each worker owns one line for its W and C estimates.
 * Every value is an advisory snapshot; no worker waits on another.
 */
export const createUnravelShared = (buffer: SharedArrayBuffer, id: number) => {
  const words = new Int32Array(buffer);
  const floats = new Float64Array(buffer);
  const clock = new BigInt64Array(buffer, 0, 1);
  const line = id + 1;
  if (words.length % UNRAVEL_SHARED_STRIDE !== 0 || !Number.isInteger(id) || id < 0 ||
    line * UNRAVEL_SHARED_STRIDE >= words.length) {
    throw new RangeError("Invalid Unravel shared layout or worker id");
  }
  const own = line * UNRAVEL_SHARED_STRIDE / 2;
  return {
    /** Epoch ms of the pool's first async start, while no awaited task has settled. */
    coldSince: (): number | undefined => {
      const us = Atomics.load(clock, 0);
      return us === 0n ? undefined : Number(us - 1n) / 1000;
    },
    markCold: (epochMs: number) => {
      Atomics.compareExchange(clock, 0, 0n, BigInt(Math.round(epochMs * 1000)) + 1n);
    },
    isWarm: () => Atomics.load(words, WARM) !== 0,
    /** Typed-array element accesses do not tear; the weight store publishes them. */
    publish: (wait: number, cpu: number, weight: number) => {
      floats[own] = wait;
      floats[own + 1] = cpu;
      Atomics.store(words, line * UNRAVEL_SHARED_STRIDE + WEIGHT, weight);
      Atomics.store(words, WARM, 1);
    },
    /** Weighted mean W / weighted mean C over every published worker. */
    ratio: (): number | undefined => {
      let wait = 0, cpu = 0;
      for (let i = UNRAVEL_SHARED_STRIDE; i < words.length; i += UNRAVEL_SHARED_STRIDE) {
        const weight = Atomics.load(words, i + WEIGHT);
        if (weight > 0) {
          wait += weight * floats[i / 2]!;
          cpu += weight * floats[i / 2 + 1]!;
        }
      }
      return cpu > 0 ? wait / cpu : undefined;
    },
  };
};

export type UnravelShared = ReturnType<typeof createUnravelShared>;

export type UnravelSample = {
  limit: number;
  previousLimit: number;
  share: number;
  probe: number;
  /** Pool-wide W/C in use; absent while the pool is cold. */
  ratio?: number;
  /** This worker's own W and C EWMAs, in ms. */
  wait?: number;
  cpu?: number;
  coldSteps?: number;
  awaiting: number;
  reason: "settle" | "grow" | "probe";
};

/** EWMA weight per settle. */
const ALPHA = .125;
/** Idle shorter than this between two readings is clock noise, not a park. */
const IDLE_EPSILON_MS = .01;
/**
 * Interrupts and preemption make a thread CPU clock fall behind wall time
 * while the thread is busy, and that gap is not idle. On Linux it reached
 * 35 µs over 0.2 ms busy stretches, 50 µs over 2 ms and 0.4 ms over 10 ms.
 */
const CPU_SLACK_MS = .05;
const CPU_SLACK_PER_BUSY_MS = .05;
/** C never reads below one microsecond. */
const MIN_CPU_MS = .001;

/** Smallest k with Erlang-B(k, x) <= epsilon, at most maxTasks. */
export const erlangCap = (x: number, epsilon: number, maxTasks: number) => {
  if (x === Infinity) return maxTasks;
  let b = 1, k = 0;
  do {
    ++k;
    b = x * b / (k + x * b);
  } while (b > epsilon && k < maxTasks);
  return k;
};

/**
 * Unravel admission: a per-worker cap under the population share, refilled on
 * every settle, with three refinements:
 *
 * 1. Cold slow start. Until the first awaited task settles anywhere in the
 *    pool, the cap is initialTasks times `growth` per tick since the pool's
 *    first async start. A worker that frees up late starts at the cap the
 *    pool has already earned.
 * 2. Erlang-B ceiling. Once warm, the cap is at most K(W/C).
 * 3. Cheap-continuation floor: the cap may rise to floor(W/C) above the share.
 *
 * A warm worker accumulates idle time at its cap with queued work. Each
 * tick of idle time doubles a probe cap, bounded by the share and reset
 * when the worker drains. Starts and settles preserve idle credit so short
 * waits can recover from the estimator's persistently low readings. An
 * earned probe shrinks proportionally if the model ceiling falls, so a
 * long-wait phase cannot pin the cap high after waits shorten.
 *
 * W and C are EWMAs over settles, usable from the first and shared
 * pool-wide. A JS worker cannot see when an awaited task became ready, so W
 * is a lower bound: the time from the task's start (after its synchronous
 * part) to the last moment the worker was idle before it settled. While a
 * worker is idle no task it holds can be ready, so the task was still
 * waiting then. The bound is exact when tasks start together and wait
 * together, as in a cold burst, and reads low when other work hides the end
 * of a wait; the idle probe exists for estimates that are too low. C is the
 * worker's busy time per settle, excluding synchronous tasks, return writes
 * and idle dispatcher passes.
 */
export const createUnravelController = ({
  options,
  shared,
  now = () => performance.timeOrigin + performance.now(),
  busy,
  threadCpu,
  onUpdate,
}: {
  options?: UnravelOptions;
  /** Absent: private state, as for a one-worker pool. */
  shared?: UnravelShared;
  /** Milliseconds on a clock every worker shares (the cold clock is pool-wide). */
  now?: () => number;
  /** This thread's busy milliseconds; idle is wall time minus busy time. */
  busy?: () => number;
  /** `busy` is a thread CPU clock; defaults to the kind of workerCpuClock(). */
  threadCpu?: boolean;
  onUpdate?: (sample: UnravelSample) => void;
} = {}) => {
  const { maxTasks, minTasks, initialTasks, growth, tickMs, epsilon, ceiling, floor } =
    resolveUnravelOptions(options);
  const pool = shared ?? createUnravelShared(new SharedArrayBuffer(unravelSharedBytes(1)), 0);
  const clock = busy === undefined ? workerCpuClock() : { read: busy, threadCpu: false };
  const busyClock = clock.read;
  const cpuSlack = threadCpu ?? clock.threadCpu;
  const clamp = (cap: number) => Math.min(maxTasks, Math.max(minTasks, cap));

  let limit = initialTasks;
  let share = initialTasks, peak = 0, owned = 0;
  let probe = 0, probeK = 1;
  let poolWarm = false;
  let probing = false, idleCredit = 0;
  const resetIdleProbe = () => {
    probing = false;
    idleCredit = 0;
  };
  // Clock readings: the last one, and the last moment the worker was idle.
  let seenWall = now(), seenBusy = busyClock();
  let idleEnd = seenWall;
  // Task CPU since the last settle while holding async tasks.
  let heldBusy = 0;
  let wait = 0, cpu = 0, samples = 0;
  let lastRatio = NaN, lastK = 1;

  /** Read the clocks; any idle since the last reading moves idleEnd forward. */
  const observe = () => {
    const t = now(), b = busyClock();
    const busySince = Math.max(0, b - seenBusy);
    // Wall time a CPU clock lost while busy also counts as busy.
    const slack = cpuSlack ? CPU_SLACK_MS + CPU_SLACK_PER_BUSY_MS * busySince : 0;
    // All busy time since the last reading is assumed to follow the idle
    // stretch, which keeps idleEnd at or before the true end.
    const idle = t - seenWall - busySince - slack;
    if (idle > IDLE_EPSILON_MS) {
      idleEnd = t - busySince - slack;
      if (probing) idleCredit += idle;
    }
    if (owned > 0) heldBusy += busySince;
    seenWall = t;
    seenBusy = b;
    return t;
  };

  const ratio = () => poolWarm || (poolWarm = pool.isWarm()) ? pool.ratio() : undefined;

  const ceilingFor = (x: number) => {
    if (x !== lastRatio) {
      lastRatio = x;
      lastK = erlangCap(x, epsilon, maxTasks);
    }
    return lastK;
  };

  const probeFor = (x: number) => Math.min(probe, Math.ceil(probe * ceilingFor(x) / probeK));

  const coldCap = (steps: number) => {
    let cap = initialTasks;
    for (let i = 0; i < steps && cap < maxTasks; i++) cap *= growth;
    return Math.min(maxTasks, cap);
  };

  const coldSteps = (t: number) => {
    const since = pool.coldSince();
    return since === undefined ? 0 : Math.max(0, Math.floor((t - since) / tickMs));
  };

  const capAt = (t: number, x = ratio()) => {
    if (x === undefined) {
      return clamp(growth === 0 ? share : Math.min(share, coldCap(coldSteps(t))));
    }
    let cap = share;
    if (ceiling) cap = Math.min(cap, Math.max(ceilingFor(x), probeFor(x)));
    if (floor) cap = Math.max(cap, Math.min(maxTasks, Math.floor(x)));
    return clamp(cap);
  };

  const update = (next: number, t: number, reason: UnravelSample["reason"], x: number | undefined) => {
    if (next === limit) return;
    const previousLimit = limit;
    limit = next;
    onUpdate?.({
      limit,
      previousLimit,
      share,
      probe: x === undefined ? 0 : probeFor(x),
      ratio: x,
      wait: samples > 0 ? wait : undefined,
      cpu: samples > 0 ? cpu : undefined,
      coldSteps: x === undefined ? coldSteps(t) : undefined,
      awaiting: owned,
      reason,
    });
  };

  return {
    getLimit: () => limit,
    start: () => {
      observe();
      return seenBusy;
    },
    /** Work that is not async task service is not task CPU. */
    exclude: (startedBusy) => {
      observe();
      if (owned > 0) heldBusy -= Math.max(0, seenBusy - startedBusy);
    },
    /** Returns the task's start, after its synchronous part, for settle. */
    asyncStarted: () => {
      const t = observe();
      ++owned;
      if (!poolWarm && !(poolWarm = pool.isWarm())) pool.markCold(t);
      return t;
    },
    isCold: () => !poolWarm,
    canProbe: () => limit < maxTasks,
    coldGrow: (backlog, workers, totalOwned = owned) => {
      if (backlog <= 0) {
        resetIdleProbe();
        return false;
      }
      const t = observe();
      // The population share grows only at the share itself.
      if (owned >= share) {
        peak = Math.max(peak, Math.ceil((Math.max(owned, totalOwned) + backlog) / Math.max(1, workers)));
        share = Math.min(maxTasks, Math.max(minTasks, peak));
      }
      const previous = limit;
      const x = ratio();
      let next = capAt(t, x);
      let reason: UnravelSample["reason"] = "grow";
      if (x !== undefined && ceiling && next < share) {
        // Count actual idle time across refills; frequent settles otherwise
        // keep restarting the probe before a low estimate can recover.
        probing = true;
        if (idleCredit >= tickMs) {
          probe = Math.min(share, maxTasks, 2 * next);
          probeK = ceilingFor(x);
          idleCredit = 0;
          next = capAt(t, x);
          reason = "probe";
        }
      } else {
        resetIdleProbe();
      }
      update(next, t, reason, x);
      return limit > previous;
    },
    settle: (awaiting: number, startedAt?: number) => {
      const t = observe();
      owned = awaiting;
      if (startedAt !== undefined) {
        const w = Math.max(0, idleEnd - startedAt);
        const c = Math.max(MIN_CPU_MS, heldBusy);
        if (samples++ === 0) {
          wait = w;
          cpu = c;
        } else {
          wait += ALPHA * (w - wait);
          cpu += ALPHA * (c - cpu);
        }
        pool.publish(wait, cpu, Math.min(samples, MAX_WEIGHT));
        poolWarm = true;
      }
      heldBusy = 0;
      if (owned === 0) {
        resetIdleProbe();
        peak = 0;
        share = initialTasks;
        probe = 0;
      }
      const x = ratio();
      update(capAt(t, x), t, "settle", x);
      return limit;
    },
    /** This worker's own EWMAs, in ms, once it has a sample. */
    estimate: () => samples > 0 ? { wait, cpu } : undefined,
  } satisfies AdmissionController & { isCold: () => boolean; estimate: () => unknown };
};
