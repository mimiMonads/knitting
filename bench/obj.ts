import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { bench, boxplot, group, run, summary } from "mitata";

export const toObject = fixedPoint({
  f: async (a: Object) => a,
});

const obj = {
  hello: 1,
  hi: "string",
  nullish: null,
  arr: [1, 2, 3, 4],
};

if (isMain) {
  const { terminateAllWorkers, toResolve } = await import(
    "./postmessage/single.ts"
  );
  const { callFunction, fastCallFunction, terminateAll, send } =
    createThreadPool({})({
      toObject,
    });

  group("Single", () => {
    summary(() => {
      bench("FF obj", async () => {
        await fastCallFunction.toObject(obj);
      });

      bench("classic", async () => {
        await Promise.all([
          toResolve(obj),
        ]);
      });
    });
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

  bench("10  obj", async () => {
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

  bench("50  obj", async () => {
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

  bench("50 classic", async () => {
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
    await run({
      format: "markdown",
    });

    await terminateAll();
    await terminateAllWorkers();
  })();
}
