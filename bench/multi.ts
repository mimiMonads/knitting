import { bench, boxplot, group, run, summary } from "mitata";
import { compose } from "../src/fixpoint.ts";
import { aaa } from "./functions.ts";

const EMPTYUI8 = new Uint8Array([1, 2, 3]);

const fn = aaa.f;

const threads = 5;
const { termminate, resolver, add, awaits } = compose({
  threads,
})({
  aaa,
});

group("1", () => {
  summary(() => {
    bench(" Main -> 1", async () => {
      return await fn(EMPTYUI8);
    });

    bench(threads + " thread -> 1", async () => {
      const arr = [
        add.aaa(EMPTYUI8),
      ];
      await awaits.aaa(arr);
    });
  });
});

group("2", () => {
  summary(() => {
    bench(" Main -> 2", async () => {
      return await Promise.all([
        fn(EMPTYUI8),
        fn(EMPTYUI8),
      ]);
    });

    bench(threads + " thread -> 2", async () => {
      const arr = [
        add.aaa(EMPTYUI8),
        add.aaa(EMPTYUI8),
      ];
      await awaits.aaa(arr);
    });
  });
});

group("3", () => {
  summary(() => {
    bench(" Main -> 3", async () => {
      return await Promise.all([
        fn(EMPTYUI8),
        fn(EMPTYUI8),
        fn(EMPTYUI8),
      ]);
    });

    bench(threads + " thread -> 3", async () => {
      const arr = [
        add.aaa(EMPTYUI8),
        add.aaa(EMPTYUI8),
        add.aaa(EMPTYUI8),
      ];
      await awaits.aaa(arr);
    });
  });
});

group("4", () => {
  summary(() => {
    bench(" Main -> 4", async () => {
      return await Promise.all([
        fn(EMPTYUI8),
        fn(EMPTYUI8),
        fn(EMPTYUI8),
        fn(EMPTYUI8),
      ]);
    });

    bench(threads + " thread -> 4", async () => {
      const arr = [
        add.aaa(EMPTYUI8),
        add.aaa(EMPTYUI8),
        add.aaa(EMPTYUI8),
        add.aaa(EMPTYUI8),
      ];
      await awaits.aaa(arr);
    });
  });

  group("5", () => {
    summary(() => {
      bench(" Main -> 5", async () => {
        return await Promise.all([
          fn(EMPTYUI8),
          fn(EMPTYUI8),
          fn(EMPTYUI8),
          fn(EMPTYUI8),
          fn(EMPTYUI8),
        ]);
      });
  
      bench(threads + " thread -> 5", async () => {
        const arr = [
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
          add.aaa(EMPTYUI8),
        ];
        await awaits.aaa(arr);
      });
    });
  })
});

await run();
await termminate();
