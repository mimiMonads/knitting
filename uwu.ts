import { createThreadPool, fixedPoint, isMain } from "./main.ts";

export const fn = fixedPoint({
  f: async () => {
    let a = 100000;
    let b = 0;
    while (a != 0) {
      b = b + performance.now();
      a--;
    }
    return b;
  },
});

export const { terminateAll, callFunction, fastCallFunction , send } = createThreadPool({
  debug: {
    logMain: true,
    logThreads: true,
  }
})({
  fn,
});

if (isMain) {
  
  await fastCallFunction.fn()
    .then((results) => {
      console.log("Results:", results);
    })
    .catch((error) => {
      console.error("Error:", error);
    })
    .finally(terminateAll);
}
