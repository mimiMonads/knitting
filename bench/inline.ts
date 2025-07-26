import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";

export const inLine = fixedPoint({
  f: async (_: void) => {},
});

const { terminateAll, callFunction, fastCallFunction, send } = createThreadPool(
  {},
)({
  inLine,
});
if (isMain) {
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
        await fastCallFunction.inLine();
      });

      summary(() => {
        bench("main", async () => {
          await inLine.f();
        });

        bench(" 1 thread -> 1", async () => {
          await fastCallFunction.inLine();
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
}
