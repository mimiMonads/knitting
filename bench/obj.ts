import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { bench, boxplot, group, run, summary } from "mitata";

export const toObject = fixedPoint({
  f: async (a: Object) => a,
});



const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const desser =   (o: Object) => textEncoder.encode(JSON.stringify(o))
const enser =  (o: Uint8Array<ArrayBufferLike>) => JSON.parse(textDecoder.decode(o))

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

  bench(" ser cost", () => {
    enser(desser(obj))
  })

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

  bench(" ser cost 5", () => {
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
  })

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

  
  bench(" ser cost 5", () => {
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
    enser(desser(obj))
  });

  (async () => {
    await run();

    await terminateAll();
    await worker.terminate();
  })();
}
