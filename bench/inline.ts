import { bench, boxplot, group, run, summary } from "mitata";
import { compose } from "../src/fixpoint.ts";
import { inLine } from "./functions.ts";

const EMPTYUI8 = new Uint8Array([1, 2, 3]);

const { termminate, add, awaits } = compose({
  threads: 1,
})({
  inLine,
});

boxplot(async () => {
  group("2", () => {
    summary(() => {
      bench("nop", async () => {
        const arr = [
          add.inLine(EMPTYUI8),
        ];

        await awaits.inLine(arr);
      });

      bench(" 1 thread -> 1", async () => {
        const arr = [
          add.inLine(EMPTYUI8),
        ];

        await awaits.inLine(arr);
      });

      bench(" 1 thread -> 2", async () => {
        const arr = [
          add.inLine(EMPTYUI8),
          add.inLine(EMPTYUI8),
        ];

        await awaits.inLine(arr);
      });

      bench(" 1 thread -> 3", async () => {
        const arr = [
          add.inLine(EMPTYUI8),
          add.inLine(EMPTYUI8),
          add.inLine(EMPTYUI8),
        ];

        await awaits.inLine(arr);
      });

      bench(" 1 thread -> 4", async () => {
        const arr = [
          add.inLine(EMPTYUI8),
          add.inLine(EMPTYUI8),
          add.inLine(EMPTYUI8),
          add.inLine(EMPTYUI8),
        ];

        await awaits.inLine(arr);
      });
    });
  });
});
await run();
await termminate();
