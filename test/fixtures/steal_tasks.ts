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
