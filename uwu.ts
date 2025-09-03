import { createThreadPool, fixedPoint, isMain } from "./knitting.ts";

export const hello = fixedPoint({
  f: async () => "hello",
});
export const world = fixedPoint({
  f: async () => "world",
});

export const { terminateAll, fastCallFunction } = createThreadPool({
  threads: 2,
  worker: {
    resolveAfterFinishinAll: true
  }
})({
  hello,
  world,
});

if (isMain) {
  await Promise.all([
    fastCallFunction.hello(),
    fastCallFunction.world(),
  ])
    .then((results) => {
      console.log("Results:", results);
    })
    .finally(terminateAll);
}