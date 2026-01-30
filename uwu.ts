import {  isMain, task , createPool} from "./knitting.ts";

export const hello = task({
  f: () => "hello ",
});

export const world = task({
  f: (args: string) => args + " world!",
});

const { call, shutdown } = createPool({
  threads: 3,
  inliner: {
    position: "last"
  }
})({
  hello,
  world,
});

if (isMain) {
  Promise.all(
    Array.from({
      length: 5,
    }).map(
      () => call.world(call.hello()),
    ),
  )
    .then(console.log)
    .finally(shutdown);
}
