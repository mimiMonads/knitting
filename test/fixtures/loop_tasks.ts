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
