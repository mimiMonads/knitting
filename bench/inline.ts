import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createThreadPool } from "../main.ts";
import { bbb } from "./functions.ts";

const EMPTYUI8 = new Uint8Array([1, 2, 3]);

const inLine = bbb;
const { terminateAll, fastCallFunction, callFunction, send } = createThreadPool(
  {
    threads: 1,
  },
)({
  inLine,
});

boxplot(async () => {
  group("1", () => {
    summary(() => {
      bench("main", async () => {
        await inLine.f(EMPTYUI8);
      });

      bench("nop", async () => {
        const arr = [
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
        ];

        send();

        await Promise.all(arr);

        await fastCallFunction.inLine(EMPTYUI8);
      });

      bench(" 1 thread -> 1", async () => {
        await fastCallFunction.inLine(EMPTYUI8);
      });

      bench(" 1 thread -> 2", async () => {
        const arr = [
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
        ];

        send();

        await Promise.all(arr);
      });

      bench(" 1 thread -> 3", async () => {
        const arr = [
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
        ];

        send();

        await Promise.all(arr);
      });

      bench(" 1 thread -> 4", async () => {
        const arr = [
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
          callFunction.inLine(EMPTYUI8),
        ];

        send();

        await Promise.all(arr);
      });
    });
  });
});
await mitataRun();
await terminateAll();
