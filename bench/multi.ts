import { bench, group, run as runMitata, summary } from "mitata";
import { createThreadPool, fixedPoint } from "../src/taskApi.ts";

const fn = fixedPoint({
  f: async () => {
    let a = 100000;
    let b = 0;
    while (a != 0) {
      b = b++;
      a--;
    }
    return b;
  },
});

const threads = 4;
const { terminateAll, callFunction, send } = createThreadPool(
  {
    threads,
    balancer: "firstAvailable",
  },
)({
  fn,
});

group("1", () => {
  summary(() => {
    bench(" Main -> 1", async () => {
      return await fn.f();
    });

    bench(threads + " thread -> 1", async () => {
      const arr = callFunction.fn();

      send();

      await arr;
    });
  });
});

group("2", () => {
  summary(() => {
    bench(threads + " thread -> 2", async () => {
      const arr = [
        callFunction.fn(),
        callFunction.fn(),
      ];

      send();

      await Promise.all(arr);
    });
  });
});

group("3", () => {
  summary(() => {
    bench(threads + " thread -> 3", async () => {
      const arr = [
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
      ];

      send();

      await Promise.all(arr);
    });
  });
});

group("4", () => {
  summary(() => {
    bench(threads + " thread -> 4", async () => {
      const arr = [
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
      ];

      send();

      await Promise.all(arr);
    });
  });

  group("4 * 4", () => {
    bench(threads + " thread -> 16", async () => {
      const arr = [
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
        callFunction.fn(),
      ];

      send();

      await Promise.all(arr);
    });
  });
});

await runMitata();
await terminateAll();
