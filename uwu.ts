import { createPool, isMain, task } from "./knitting.ts";

let num = 0;
const arr: number[] = [];

export const hello = task({
  f: async () => num++,
});

const { shutdown, fastCall } = createPool({})({
  hello,
});

const fn = (n: number) => arr.push(n);
if (isMain) {
  await Promise.all([
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
    fastCall.hello().then(fn),
  ])
    .then(() => {
      console.log("Results:", arr);
    })
    .finally(shutdown);
}
