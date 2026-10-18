import { task } from "../../knitting.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const addOne = task<number, number>({
  f: (value) => value + 1,
});

export const delayedEcho = task<number, number>({
  f: async (value) => {
    await delay(value);
    return value;
  },
});

/** Resolves immediately: isolates the worker's awaiting path from the work. */
export const addOneAsync = task<number, number>({
  f: async (value) => value + 1,
});

export const rejectOrEchoAsync = task<number, number>({
  f: async (value) => {
    await delay(1);
    if (value < 0) throw new Error("expected async failure");
    return value;
  },
});

/** Awaits `ms`, then returns [started, finished] on a clock shared by threads. */
export const stampedDelay = task<number, number[]>({
  f: async (ms) => {
    const started = performance.timeOrigin + performance.now();
    await delay(ms);
    return [started, performance.timeOrigin + performance.now()];
  },
});

/** Counts admissions without allowing any completion before the host releases. */
export const gatedCountRecovery = task<SharedArrayBuffer, number>({
  f: async (buffer) => {
    const control = new Int32Array(buffer);
    const id = Atomics.add(control, 0, 1);
    while (Atomics.load(control, 1) === 0) await delay(2);
    return id;
  },
});

/** Record admissions and timer continuations to detect refill waves. */
export const timerRefillOrder = task<SharedArrayBuffer, number>({
  f: async (buffer) => {
    const log = new Int32Array(buffer);
    const id = Atomics.add(log, 0, 1);
    Atomics.store(log, 2 + Atomics.add(log, 1, 1), id + 1);
    const waiting = delay(20);
    // Register both timers, then keep the dispatcher busy until both are
    // overdue before it can enter the next timer phase. Merely burning CPU
    // inside timer 1 does not refresh libuv's cached timer-phase timestamp.
    if (id === 1) {
      const until = performance.now() + 35;
      while (performance.now() < until) {}
    }
    await waiting;
    // Refill should start task 3 between the two now-ready callbacks.
    const until = performance.now() + 8;
    while (performance.now() < until) {}
    Atomics.store(log, 2 + Atomics.add(log, 1, 1), -(id + 1));
    return id;
  },
});
