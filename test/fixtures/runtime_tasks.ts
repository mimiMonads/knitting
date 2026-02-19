import { task } from "../../knitting.ts";
import { fileURLToPath } from "node:url";

export const addOnePromise = task<Promise<number> | number, number>({
  f: async (value) => value + 1,
});

const runtimeTaskPath = fileURLToPath(import.meta.url);

// Exercises filesystem-path href normalization (including Windows drive paths).
export const addOnePromiseViaPath = task<Promise<number> | number, number>({
  href: runtimeTaskPath,
  f: async (value) => value + 1,
});
