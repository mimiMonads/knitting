import { bench, boxplot, group, run, summary } from "mitata";
import { compose } from "../src/fixpoint.ts";
import { aaa } from "./functions.ts";

const EMPTYUI8 = new Uint8Array([1, 2, 3]);

const { termminate, resolver, add, awaits } = compose({
  threads: 4,
})({
  aaa,
});

boxplot(async () => {
  group("2", () => {
    summary(() => {
      bench(" nop ", async () => {
        const arr = [
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
        ];

        await awaits.aaa(arr);
      });

      bench(" 2 thread -> 1", async () => {
        const arr = [
          add.aaa(EMPTYUI8),
        ];

        await awaits.aaa(arr);
      });

      bench(" 2 thread -> 2", async () => {
        const arr = [
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
        ];

        await awaits.aaa(arr);
      });

      bench(" 2 thread -> 3", async () => {
        const arr = [
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
        ];

        await awaits.aaa(arr);
      });

      bench(" 2 thread -> 4", async () => {
        const arr = [
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
        ];

        await awaits.aaa(arr);
      });
    });
  });
});
await run();
await termminate();
