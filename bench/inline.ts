import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createThreadPool } from "../main.ts";
import { bbb } from "./functions.ts";

const inLine = bbb;
const { terminateAll, callFunction, send } = createThreadPool(
  {
    threads: 1,
  },
)({
  inLine,
});

boxplot(async () => {
  group("1", () => {
    bench("nop", async () => {
      const arr = [
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
      ];

      send();

      await Promise.all(arr);
    });

    summary(() => {
      bench("main", async () => {
        await inLine.f();
      });

      bench(" 1 thread -> 1", async () => {
        const arr = callFunction.inLine();

        send();

        await arr;
      });

      bench(" 1 thread -> 2", async () => {
        const arr = [
          callFunction.inLine(),
          callFunction.inLine(),
        ];

        send();

        await Promise.all(arr);
      });

      bench(" 1 thread -> 3", async () => {
        const arr = [
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
        ];

        send();

        await Promise.all(arr);
      });

      bench(" 1 thread -> 4", async () => {
        const arr = [
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
        ];

        send();

        await Promise.all(arr);
      });

      bench(" 1 thread -> 5", async () => {
        const arr = [
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
        ];

        send();

        await Promise.all(arr);
      });

      bench(" 1 thread -> 10", async () => {
        const arr = [
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
        ];

        send();

        await Promise.all(arr);
      });
    });
  });
});
await mitataRun();
await terminateAll();
