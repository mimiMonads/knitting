import { isMain, task } from "../../knitting.ts";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const laneFlag = task<number, boolean>({
  f: async (ms) => {
    if (ms > 0) {
      await sleep(ms);
    }
    return isMain;
  },
});

