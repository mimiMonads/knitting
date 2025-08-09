import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { terminateAllWorkers, toResolve } from "./postmessage/multi.ts";

export const inLine = fixedPoint({
  f: async (a?: object | void) => a,
});

const obj = {
  hello: 1,
  hi: "string",
  nullish: null,
  arr: [1, 2, 3, 4],
};

const { terminateAll, callFunction, send } = createThreadPool(
  { threads: 4 },
)({
  inLine,
});

if (isMain) {
  const sizes = [10, 100, 1000, 10000];

  boxplot(async () => {
    group("worker", () => {
      summary(() => {
        for (const size of sizes) {
          bench(`4 thread → ${size}`, async () => {
            // build an array of `size` promises
            const arr = Array(size)
              .fill(0)
              .map(() => toResolve(obj));

            // kick off workers
            send();

            // wait for all to resolve
            await Promise.all(arr);
          });
        }
      });
    });

    group("knitting", () => {
      summary(() => {
        for (const size of sizes) {
          bench(`4 thread → ${size}`, async () => {
            const arr = Array(size)
              .fill(0)
              .map(() => callFunction.inLine(obj));

            send();
            await Promise.all(arr);
          });
        }
      });
    });
  });

  await mitataRun({ format: "markdown" });
  await terminateAllWorkers();
  await terminateAll();
}
