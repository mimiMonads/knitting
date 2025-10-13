import { createPool, isMain, task } from "./knitting.ts";

export const hello = task({
  f: async () => "hello",
});
export const world = task({
  f: async () => "world",
});

const { shutdown, fastCall } = createPool({
  threads: 3,
  balancer: "robinRound",
  inliner: {
    position: "last"
  }
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
