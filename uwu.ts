import {  isMain, task , createPool} from "./knitting.ts";

export const hello = task({
  f: () => "hello ",
});

export const world = task({
  f: (args: string) => args + " world!",
});

const { call, shutdown } = createPool({
  inliner:{
    dispatchThreshold: 12
  },
  host: {
    maxBackoffMs: 300,
  },
})({
  hello,
  world,
});

if (isMain) {
  Promise.all(
    Array.from({
      length: 100,
    }).map(
      () => call.world(call.hello()),
    ),
  )
    .then(console.log)
    .finally(shutdown);
}
