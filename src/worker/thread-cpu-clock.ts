import { getNodeBuiltinModule, getNodeProcess } from "../common/node-compat.ts";
import { RUNTIME } from "../common/runtime.ts";

type BunFfi = {
  dlopen: (path: string, symbols: {
    clock_gettime: { args: ["i32", "ptr"]; returns: "i32" };
  }) => { symbols: { clock_gettime: (clock: number, out: Int32Array) => number } };
};

type NodeFs = {
  openSync: (path: string, flags: string) => number;
  readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => number;
  closeSync: (fd: number) => void;
};

/** Linux clockid_t of CLOCK_THREAD_CPUTIME_ID. */
const CLOCK_THREAD_CPUTIME_ID = 3;
/** A wall-minus-CPU gap below this is not worth a schedstat read. */
const RUN_DELAY_CHECK_MS = .05;

/**
 * This thread's runqueue wait in ms, the second field of
 * /proc/thread-self/schedstat: time it was runnable but had no CPU, from
 * preemption or CFS bandwidth throttling.
 */
const linuxRunDelay = (): (() => number) | undefined => {
  const fs = getNodeBuiltinModule<NodeFs>("node:fs");
  if (fs === undefined) return undefined;
  try {
    const text = new Uint8Array(80);
    const read = () => {
      // Opened per read (about 3 µs, only on gaps): an fd belongs to the
      // process and would outlive this worker. /proc/thread-self resolves
      // to the calling thread.
      const fd = fs.openSync("/proc/thread-self/schedstat", "r");
      let length: number;
      try {
        length = fs.readSync(fd, text, 0, text.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      let i = 0, ns = 0;
      while (i < length && text[i] !== 32) i++;
      for (i++; i < length && text[i]! >= 48 && text[i]! <= 57; i++) {
        ns = ns * 10 + text[i]! - 48;
      }
      return ns / 1e6;
    };
    read();
    return read;
  } catch {
    return undefined;
  }
};

/**
 * Adds runqueue wait to a thread CPU clock where schedstat is readable, so
 * an oversubscribed or throttled thread does not read as idle. Like Node's
 * event-loop active time, the result then excludes only blocked time.
 */
const withRunDelay = (cpuNow: () => number): () => number => {
  const runDelay = linuxRunDelay();
  if (runDelay === undefined) return cpuNow;
  let lastWall = performance.now(), lastCpu = cpuNow();
  let lastDelay = runDelay(), busy = lastCpu;
  return () => {
    const wall = performance.now(), cpu = cpuNow();
    const gap = wall - lastWall - (cpu - lastCpu);
    busy += cpu - lastCpu;
    if (gap > RUN_DELAY_CHECK_MS) {
      // Waits that started before this reading count here too, but never as
      // more than the gap. A failed read leaves the gap as idle.
      let delay: number;
      try {
        delay = runDelay();
      } catch {
        delay = lastDelay;
      }
      busy += Math.min(gap, Math.max(0, delay - lastDelay));
      lastDelay = delay;
    }
    lastWall = wall;
    lastCpu = cpu;
    return busy;
  };
};

/**
 * Bun on Linux: clock_gettime(CLOCK_THREAD_CPUTIME_ID) through bun:ffi.
 * Unlike getrusage(), it adds the runtime since the last scheduler tick.
 */
const bunLinuxThreadCpuClock = (): (() => number) | undefined => {
  const process = getNodeProcess();
  if (RUNTIME !== "bun" || process?.platform !== "linux") return undefined;
  const ffi = getNodeBuiltinModule<BunFfi>("bun:ffi");
  if (typeof ffi?.dlopen !== "function") return undefined;
  const musl = `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`;
  for (const path of ["libc.so.6", musl]) {
    try {
      const { clock_gettime } = ffi.dlopen(path, {
        clock_gettime: { args: ["i32", "ptr"], returns: "i32" },
      }).symbols;
      // A timespec of two 64-bit little-endian words; thread CPU seconds fit
      // the low word. Pass the array on every call: the GC may move a small
      // typed array, which leaves a cached ptr() reading a stale copy.
      const timespec = new Int32Array(4);
      if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, timespec) !== 0) continue;
      return () => {
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, timespec);
        return timespec[0]! * 1e3 + timespec[2]! / 1e6;
      };
    } catch {
    }
  }
  return undefined;
};

const processThreadCpuClock = (): (() => number) | undefined => {
  const process = getNodeProcess();
  if (typeof process?.threadCpuUsage !== "function") return undefined;
  const read = process.threadCpuUsage.bind(process);
  return () => {
    const usage = read();
    return (usage.user + usage.system) / 1000;
  };
};

/** Largest step a fine CPU clock takes between two readings while spinning. */
const FINE_CLOCK_STEP_MS = .05;
/** Consecutive fine steps, within FINE_CLOCK_RUN_MS of wall time. */
const FINE_CLOCK_STEPS = 8;
const FINE_CLOCK_RUN_MS = .25;

/**
 * Whether the CPU clock `read` advances in small steps while this thread
 * spins: a guard for clocks no platform rule vouches for. A tick-based clock
 * still takes an occasional small step, and under heavy preemption every
 * context switch refreshes it, so it can rarely pass; it is never chosen
 * where it is known to be tick-based. Bounded by reads, not wall time, so
 * preemption cannot end it early.
 */
const hasFineSteps = (read: () => number) => {
  let last = read(), run = 0, runStart = 0;
  for (let reads = 0; reads < 20_000 && run < FINE_CLOCK_STEPS; reads++) {
    const value = read();
    if (value === last) continue;
    if (value - last > FINE_CLOCK_STEP_MS) run = 0;
    else {
      const t = performance.now();
      if (run === 0 || t - runStart > FINE_CLOCK_RUN_MS) {
        run = 0;
        runStart = t;
      }
      run++;
    }
    last = value;
  }
  return run === FINE_CLOCK_STEPS;
};

/**
 * This thread's busy time in ms from a fine-grained thread CPU clock, or
 * undefined where there is none.
 *
 * getrusage(RUSAGE_THREAD), behind threadCpuUsage() on Linux, advances only
 * on scheduler ticks (4 ms at HZ=250), so a short busy stretch reads as idle.
 * On Linux, Bun reads clock_gettime through bun:ffi instead and counts
 * runqueue wait as busy (see withRunDelay). macOS uses threadCpuUsage(),
 * checked for fine steps. Other platforms have only tick-based thread clocks.
 */
export const threadCpuClock = (): (() => number) | undefined => {
  const platform = getNodeProcess()?.platform;
  if (platform === "linux") {
    // No threadCpuUsage() fallback: it is tick-based here.
    const cpu = bunLinuxThreadCpuClock();
    return cpu === undefined ? undefined : withRunDelay(cpu);
  }
  if (platform === "darwin") {
    const cpu = processThreadCpuClock();
    return cpu !== undefined && hasFineSteps(cpu) ? cpu : undefined;
  }
  return undefined;
};
