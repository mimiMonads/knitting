import { task } from "../../knitting.ts";

export const double = task<number, number>({ f: (value) => value * 2 });
// Keep the worker in synchronous work long enough for the host to arm its
// completion doorbell. An async delay would itself flush Bun's IPC pipe.
export const delayedSyncDouble = task<number, number>({
  f: (value) => {
    const until = performance.now() + 20;
    while (performance.now() < until) {}
    return value * 2;
  },
});
export const concat = task<string, string>({ f: (value) => `${value}!` });

// Each worker loads this module once, so the value names the worker that ran a
// task without relying on a runtime-specific thread id.
const workerTag = Math.random();
/**
 * Waits on work outside the worker, then spins on it: the shape of a build
 * step that awaits a child process and then runs a synchronous minifier.
 */
export const awaitThenSpin = task<number, number>({
  f: async (spinMs) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const until = performance.now() + spinMs;
    while (performance.now() < until) {}
    return workerTag;
  },
});
