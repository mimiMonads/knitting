import { createThreadPool, fixedPoint, isMain } from "./knitting.ts";

export const hello = fixedPoint({
  f: async () => "hello",
});
export const world = fixedPoint({
  f: async () => "world",
});

export const { terminateAll, fastCallFunction } = createThreadPool({
  threads: 3,
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
    fastCallFunction.hello(),
    fastCallFunction.world(),
    fastCallFunction.world(),
  ])
    .then((results) => {
      console.log("Results:", results);
    })
    .finally(terminateAll)

}
