import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { bench, boxplot, group, run, summary } from "mitata";
import { worker } from "./echo.ts";

export const toNumber = fixedPoint({
  f: async (a: number) => a,
});

export const toString = fixedPoint<string, string>({
  f: async (a) => a,
});

export const toBigInt = fixedPoint<bigint, bigint>({
  f: async (a) => a,
});

export const toBoolean = fixedPoint<boolean, boolean>({
  f: async (a) => a,
});

export const toVoid = fixedPoint({
  f: async (a) => a,
});

export const toObject = fixedPoint({
  f: async (a) => a,
});

const obj = {
  number: 123,
  string: "helloWorld",
  nullable: null,
  arr: [1, 2, 3, 4, 5],
};

const arr = [1, 2, 3, 4, 5];
if (isMain) {
  const { worker, toResolve } = await import("./echo.ts");
  const { callFunction, fastCallFunction, terminateAll, send } =
    createThreadPool({
      balancer: "firstAvailable",
    })({
      toNumber,
      toString,
      toBigInt,
      toBoolean,
      toVoid,
      toObject,
    });

  bench("All functions", async () => {
    const promises = [
      callFunction.toString("hello"),
      callFunction.toBigInt(-(2n ** 63n - 1n)),
      callFunction.toBigInt(2n ** 64n - 1n),
      callFunction.toBoolean(true),
      callFunction.toBoolean(false),
      callFunction.toVoid(),
      callFunction.toNumber(Infinity),
      callFunction.toNumber(-Infinity),
      callFunction.toNumber(NaN),
      callFunction.toNumber(Number.MAX_SAFE_INTEGER),
      callFunction.toNumber(Number.MIN_SAFE_INTEGER),
      callFunction.toNumber(Number.MAX_VALUE),
      callFunction.toNumber(Number.MIN_VALUE),
      callFunction.toNumber(0),
      callFunction.toNumber(2.2250738585072014e-308),
      callFunction.toObject(null),
    ];

    send();

    await Promise.all(promises);
  });

  bench("clasic", async () => {
    const promises = [
      toResolve("hello"),
      toResolve(-(2n ** 63n - 1n)),
      toResolve(2n ** 64n - 1n),
      toResolve(true),
      toResolve(false),
      toResolve(undefined),
      toResolve(Infinity),
      toResolve(-Infinity),
      toResolve(NaN),
      toResolve(Number.MAX_SAFE_INTEGER),
      toResolve(Number.MIN_SAFE_INTEGER),
      toResolve(Number.MAX_VALUE),
      toResolve(Number.MIN_VALUE),
      toResolve(0),
      toResolve(2.2250738585072014e-308),
      toResolve(null),
    ];

    await Promise.all(promises);
  });

  boxplot(async () => {
    bench("CF string", async () => {
      const res = callFunction.toString("sss");
      send();
      await res;
    });

    bench("FF string", async () => {
      await fastCallFunction.toString("hello");
    });
  });

  boxplot(async () => {
    bench("CF number", async () => {
      const res = callFunction.toNumber(77777);
      send();
      await res;
    });

    bench("CF Infinity", async () => {
      const res = callFunction.toNumber(Infinity);
      send();
      await res;
    });

    bench("FF number", async () => {
      await fastCallFunction.toNumber(77777);
    });

    bench("FF Infinity", async () => {
      await fastCallFunction.toNumber(Infinity);
    });
  });

  boxplot(async () => {
    bench("CF simple arr", async () => {
      const res = callFunction.toObject(arr);
      send();
      await res;
    });
    bench("FF simple arr", async () => {
      await fastCallFunction.toObject(arr);
    });

    bench("CF obj", async () => {
      const res = callFunction.toObject(obj);
      send();
      await res;
    });

    bench("FF obj", async () => {
      await fastCallFunction.toObject(obj);
    });

    bench("classic", async () => {
      await Promise.all([
        toResolve(obj),
        toResolve(obj),
      ]);
    });
  });

  (async () => {
    await run();

    await terminateAll();
    await worker.terminate();
  })();
}
