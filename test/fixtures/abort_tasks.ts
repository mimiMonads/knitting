import { task } from "../../knitting.ts";

const neverSettles = () => new Promise<never>(() => {});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const abortA = task({
  abortSignal: true,
  f: neverSettles,
});

export const abortB = task({
  abortSignal: true,
  f: neverSettles,
});

export const abortC = task({
  abortSignal: true,
  f: neverSettles,
});

export const abortReturnsInput = task({
  abortSignal: { hasAborted: true },
  f: async (value: string, signal) => {
    while (!signal.hasAborted()) {
      await delay(1);
    }
    return value;
  },
});
