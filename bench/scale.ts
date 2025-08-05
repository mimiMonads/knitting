import { bench, run as runMitata, summary } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { toResolve, worker } from "./echo.ts";
export const fn = fixedPoint({
  f: async (a: object) => a,
});

const threads = 1;
const { terminateAll, callFunction, send, fastCallFunction } = createThreadPool(
  {
    threads,
  },
)({
  fn,
});

const obj = [1, 2, 3, 4, 5, 6, 7, {
  hello: 1,
  hi: "string",
  xd: null,
}];
const timesFun = async (n: number) => {
  const arr = [
    callFunction.fn(),
  ];

  let i = 0;

  while (i !== n) {
    arr.push(
      callFunction.fn(),
    );
    i++;
  }

  send();

  await Promise.all(arr);
};

const meh = async (n: number) => {
  const arr = [
    toResolve(),
  ];

  let i = 0;

  while (i !== n) {
    arr.push(
      toResolve(),
    );
    i++;
  }

  await Promise.all(arr);
};

if (isMain) {
  summary(() => {
    bench(threads + " thread -> 1", async () => {
      await timesFun(1);
    });
    bench(threads + " thread -> 10", async () => {
      await timesFun(10);
    });

    bench(threads + " thread  (to beat)-> 10", async () => {
      await meh(10);
    });

    bench(threads + " thread -> 50", async () => {
      await timesFun(50);
    });
    bench(threads + " thread -> 100", async () => {
      await timesFun(100);
    });
    bench(threads + " thread -> 1000", async () => {
      await timesFun(1000);
    });

    bench(threads + " thread (to beat) -> 1000", async () => {
      await meh(1000);
    });

    bench(threads + " thread -> 10000", async () => {
      await timesFun(10000);
    });

    bench(threads + " thread (to beat) -> 10000", async () => {
      await meh(10000);
    });
  });

  await runMitata();
  await terminateAll();
  await worker.terminate();
}
