import { bench, run as runMitata, summary } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { toResolve, worker } from "./echo.ts";
export const fn = fixedPoint({
  f: async (a: object) => a,
});

const threads = 1;
const { terminateAll, callFunction, send } = createThreadPool(
  {
    threads,
  },
)({
  fn,
});

const obj = {
  hello: 1,
  hi: "string",
  nullish: null,
  arr: [1, 2, 3, 4],
};

const timesFun = async (n: number) => {
  const arr = [
    callFunction.fn(obj),
  ];

  let i = 0;

  while (i !== n) {
    arr.push(
      callFunction.fn(obj),
    );
    i++;
  }

  send();

  await Promise.all(arr);
};

const meh = async (n: number) => {
  const arr = [
    toResolve(obj),
  ];

  let i = 0;

  while (i !== n) {
    arr.push(
      toResolve(obj),
    );
    i++;
  }

  await Promise.all(arr);
};

if (isMain) {
  summary(() => {
    bench(threads + " thread -> 10", async () => {
      await timesFun(10);
    });

    bench(threads + " thread  (to beat)-> 10", async () => {
      await meh(10);
    });

    bench(threads + " thread -> 1000", async () => {
      await timesFun(1000);
    });

    bench(threads + " thread (to beat) -> 1000", async () => {
      await meh(1000);
    });

    bench(threads + " thread -> 100_000", async () => {
      await timesFun(100000);
    });

    bench(threads + " thread (to beat) -> 100_000", async () => {
      await meh(100000);
    });
  });

  await runMitata();
  await terminateAll();
  await worker.terminate();
}
