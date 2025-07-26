import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { bench, boxplot, group, run, summary } from "mitata";

export const toObject = fixedPoint({
  f: async (a: Object) => a,
});



const obj = [1,2,3,4,5,6,7,{
  hello: 1,
  hi: "string"
}]

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
    await run();

    await terminateAll();
    await worker.terminate();
  })();
}
