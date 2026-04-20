import { task } from "../../knitting.ts";

export const pooledSlowHello = task({
  abortSignal: {
    hasAborted: true,
  },
  f: (name: string, signal) =>
    signal.hasAborted() ? "aborted" : `hello ${name}`,
});
