import { bench, boxplot, group, run as runMitata, summary } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { terminateAllWorkers, toResolve } from "./postmessage/single.ts";

const json = { debug: false, samples: false };
const format = process.argv.includes("--json")
  ? {
    json,
  }
  : "markdown";

export const fn = fixedPoint({
  f: async (a: object) => a,
});

const threads = 1;
const { terminateAll, callFunction, send } = createThreadPool({ threads })({
  fn,
});

const obj = {
  hello: 1,
  hi: "string",
  nullish: null,
  arr: [1, 2, 3, 4],
};

const timesFun = async (n: number) => {
  const arr = Array.from({ length: n }, () => callFunction.fn(obj));
  send();
  await Promise.all(arr);
};

const meh = async (n: number) => {
  const arr = Array.from({ length: n }, () => toResolve(obj));
  await Promise.all(arr);
};

if (isMain) {
  const sizes = [10, 100, 1000];

  boxplot(async () => {
    group("worker", () => {
      summary(() => {
        for (const size of sizes) {
          bench(`${threads} thread → (${size})`, async () => {
            await meh(size);
          });
        }
      });
    });

    group("knitting", () => {
      summary(() => {
        for (const size of sizes) {
          bench(`${threads} thread → (${size})`, async () => {
            await timesFun(size);
          });
        }
      });
    });
  });

  await runMitata({ format });
  await terminateAll();
  await terminateAllWorkers();
}
