import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { shutdownWorkers, toResolve } from "./postmessage/multi.ts";
import { format, print } from "./ulti/json-parse.ts";

export const inLine = task({
  f: async (a?: object | void | Set<number>) => a,
});

const obj = {
  hello: 1,
  hi: "string",
  nullish: null,
  arr: [1, 2, 3, 4],
};

const { shutdown, call, send } = createPool(
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
            const arr = Array(size)
              .fill(0)
              .map(() => call.inLine(obj));

            send();
            await Promise.all(arr);
          });
        }
      });
    });

    group("worker", () => {
      summary(() => {
        for (const size of sizes) {
          bench(`4 thread → (${size})`, async () => {
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
  });

  await mitataRun({ format, print });
  await shutdownWorkers();
  await shutdown();
}
