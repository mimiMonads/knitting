import { bench, boxplot, group, run, summary } from "mitata";
import { compose } from "./fixpoint.ts";
import { aaa } from "./functions.ts";

const EMPTYUI8 = new Uint8Array([1, 2, 3]);

const f = aaa.f;

const { termminate, resolver, add , awaits} = compose({
  threads: 3,
})({
  aaa,
});

boxplot(async () => {
  group("3", () => {
    summary(() => {


      bench(" 6 thread -> 1", async () => {

        const arr = [
          add.aaa(EMPTYUI8),
        ] 

        await awaits.aaa(arr)
      });

      bench(" 6 thread -> 2", async () => {

        const arr = [
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
        ] 

        await awaits.aaa(arr)
      });

      bench(" 6 thread -> 3", async () => {

        const arr = [
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8)
        ] 

        await awaits.aaa(arr)
      });

    });
  });
});
await run();
await termminate();
