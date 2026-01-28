import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { shutdownWorkers, toResolve } from "./postmessage/multi.ts";
import { format, print } from "./ulti/json-parse.ts";

export const inLine = task({
  f: (a?: object | void | Set<number>) => a,
});

const obj = {
  hello: "world",
  arr: [1, 2, 3, 4],
};

const { shutdown, call } = createPool(
  { threads: 4 },
)({
  inLine,
});

if (isMain) {
  const sizes = [10, 100, 1000];

  boxplot(async () => {
    group("knitting", () => {
      summary(() => {
        for (const size of sizes) {
          bench(`4 thread → (${size})`, async () => {
            await Promise.all(Array(size)
              .map(() => call.inLine(obj)));
          });
        }
      });
    });

    group("worker", () => {
      summary(() => {
        for (const size of sizes) {
          bench(`4 thread → (${size})`, async () => {
            // wait for all to resolve
            await Promise.all(Array(size)
              .map(() => toResolve(obj)));
          });
        }
      });
    });
  });

  await mitataRun({ format, print });
  await shutdownWorkers();
  await shutdown();
}
