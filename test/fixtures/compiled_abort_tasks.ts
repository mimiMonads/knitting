import { task } from "../../knitting.ts";

export const abortSpin = task({
  abortSignal: true,
  f: (value: number, signal) => {
    let steps = 0;
    while (steps < 100_000_000 && !signal.hasAborted()) steps++;
    return signal.hasAborted() ? value : -1;
  },
});
