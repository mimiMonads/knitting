import { task } from "../../knitting.ts";

export const abortContextProbe = task({
  abortSignal: {
    hasAborted: true,
  },
  f: (_: undefined, tbh) => {
    return tbh.hasAborted() ? 1 : 0;
  },
});
