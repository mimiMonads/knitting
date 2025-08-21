import { createThreadPool, fixedPoint, isMain } from "./knitting.ts";

export const hello = fixedPoint({
  f: async () => "hello",
});
export const world = fixedPoint({
  f: async () => "world",
});

export const { terminateAll, fastCallFunction, callFunction, send } =
  createThreadPool({
    debug: {
      logMain: true,
      //logThreads: true,
    },
  })({
    hello,
    world,
  });

if (isMain) {
  await Promise.all([
    callFunction.hello(),
    callFunction.world(),
    callFunction.world(),
    callFunction.hello(),
    callFunction.world(),
    callFunction.world(),
    send(),
  ])
    .then(async (results) => {
      console.log("Results:", results);

      await new Promise((res) => setTimeout(res, 20));
    })
    .then(async () =>
      await Promise.all([
        callFunction.hello(),
        callFunction.world(),
        callFunction.world(),
        callFunction.hello(),
        callFunction.world(),
        callFunction.world(),
        send(),
      ])
    )
    .then((results) => {
      console.log("Results:", results);
    })
    .finally(terminateAll);
}
