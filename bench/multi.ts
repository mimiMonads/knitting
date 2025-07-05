import { bench, group, run as runMitata, summary } from "mitata";
import { createThreadPool } from "../src/taskApi.ts";
import { aaa } from "./functions.ts";

const fn = aaa.f;

const threads = 4;
const { terminateAll, callFunction, send } = createThreadPool(
  {
    threads,
    balancer: "firstAvailable",
  },
)({
  aaa,
});

group("1", () => {
  summary(() => {
    bench(" Main -> 1", async () => {
      return await fn();
    });

    bench(threads + " thread -> 1", async () => {
      const arr = callFunction.aaa();

      send();

      await arr;
    });
  });
});

group("2", () => {
  summary(() => {
    bench(threads + " thread -> 2", async () => {
      const arr = [
        callFunction.aaa(),
        callFunction.aaa(),
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
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
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
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
      ];

      send();

      await Promise.all(arr);
    });
  });

  group("4 * 4", () => {
    bench(threads + " thread -> 16", async () => {
      const arr = [
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
        callFunction.aaa(),
      ];

      send();

      await Promise.all(arr);
    });
  });
});

await runMitata();
await terminateAll();
