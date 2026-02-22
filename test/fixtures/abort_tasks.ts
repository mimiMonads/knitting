import { task } from "../../knitting.ts";

const neverSettles = () => new Promise<never>(() => {});

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
