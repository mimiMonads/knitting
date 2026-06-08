import { createPool, task } from "../../knitting.ts";

const explicitPlain = task<number, number>({
  f: (value) => value * 2,
});

const inferredPlain = task({
  f: (value: number) => value + 1,
});

const abortAware = task({
  abortSignal: { hasAborted: true },
  f: (value: number, signal) => signal.hasAborted() ? 0 : value,
});

const bareFunction = (value: number) => value - 1;

const pool = createPool({ threads: 1 })({
  explicitPlain,
  inferredPlain,
  abortAware,
  bareFunction,
});

pool.call.explicitPlain(2);
pool.call.inferredPlain(2);
pool.call.abortAware(2);
pool.call.bareFunction(2);

// @ts-expect-error plain task input is still checked.
pool.call.explicitPlain("2");

// @ts-expect-error abort-aware host call keeps the worker signal internal.
pool.call.abortAware(2, { hasAborted: () => false });
