import { createPool, isMain, task } from "./knitting.ts";

export const hello = task({
  f: async () => "hello",
});
export const world = task({
  f: async () => "world",
});

export const { shutdown, fastCall } = createPool({
  threads: 1,
})({
  hello,
  world,
});

if (isMain) {
  await Promise.all([
    fastCall.hello(),
    fastCall.world(),
        fastCall.hello(),
    fastCall.world(),
  ])
    .then((results) => {
      console.log("Results:", results);
    })
    .finally(shutdown);
}