import { bench, boxplot, group, run, summary } from "mitata";
import { createThreadPool } from "../src/taskApi.ts";
import { bbb } from "./functions.ts";

const EMPTYUI8 = new Uint8Array([1, 2, 3]);

const inLine = bbb;
const { terminateAll, enqueue, awaitAll, callFunction } = createThreadPool({
  threads: 1,
})({
  inLine,
});

boxplot(async () => {
  group("1", () => {
    summary(() => {
      bench("main", async () => {
        await inLine.f(EMPTYUI8);
      });

      bench(" 1 thread -> 1", async () => {
        await callFunction.inLine(EMPTYUI8);
      });

      bench(" 1 thread -> 2", async () => {
        const arr = [
          enqueue.inLine(EMPTYUI8),
          enqueue.inLine(EMPTYUI8),
        ];

        await awaitAll.inLine(arr);
      });

      bench(" 1 thread -> 3", async () => {
        const arr = [
          enqueue.inLine(EMPTYUI8),
          enqueue.inLine(EMPTYUI8),
          enqueue.inLine(EMPTYUI8),
        ];

        await awaitAll.inLine(arr);
      });

      bench(" 1 thread -> 4", async () => {
        const arr = [
          enqueue.inLine(EMPTYUI8),
          enqueue.inLine(EMPTYUI8),
          enqueue.inLine(EMPTYUI8),
          enqueue.inLine(EMPTYUI8),
        ];

        await awaitAll.inLine(arr);
      });
    });
  });
});
await run();
await terminateAll();
