import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { bench, boxplot, group, run, summary } from "mitata";

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

if (isMain) {
  const { worker, toResolve } = await import("./echo.ts");
  const { callFunction, fastCallFunction, terminateAll, send } =
    createThreadPool({})({
      toObject,
    });

  bench("FF obj", async () => {
    await fastCallFunction.toObject(obj);
  });

  bench("classic", async () => {
    await Promise.all([
      toResolve(obj),
    ]);
  });

  bench("5  obj", async () => {
    const arr = [
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
    ];
    send();

    await Promise.all(arr);
  });

  bench(" 5 classic", async () => {
    await Promise.all([
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
    ]);
  });

  bench("5  obj", async () => {
    const arr = [
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
      callFunction.toObject(obj),
    ];
    send();

    await Promise.all(arr);
  });

  bench("10 classic", async () => {
    await Promise.all([
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
      toResolve(obj),
    ]);
  });

  (async () => {
    await run();

    await terminateAll();
    await worker.terminate();
  })();
}
