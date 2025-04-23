import { bench, group, run as runMitata, summary } from "mitata";
import { createThreadPool } from "../src/taskApi.ts";
import { aaa } from "./functions.ts";

const fn = aaa.f;

const threads = 4;
const { terminateAll, callFunction, send } = createThreadPool(
  {
    threads,
  },
)({
  aaa,
});

bench(" nop", async () => {
  const arr = [
    callFunction.aaa(),
    callFunction.aaa(),
    callFunction.aaa(),
    callFunction.aaa(),
  ];

  send();

  await Promise.all(arr);
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
    bench(" Main -> 2", async () => {
      return await Promise.all([
        fn(),
        fn(),
      ]);
    });

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
    bench(" Main -> 3", async () => {
      return await Promise.all([
        fn(),
        fn(),
        fn(),
      ]);
    });

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
    bench(" Main -> 4", async () => {
      return await Promise.all([
        fn(),
        fn(),
        fn(),
        fn(),
      ]);
    });

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
    summary(() => {
      bench(" Main -> 16", async () => {
        return await Promise.all([
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
          fn(),
        ]);
      });

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
});

await runMitata();
await terminateAll();
