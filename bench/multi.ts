import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { terminateAllWorkers, toResolve } from "./postmessage/multi.ts";

export const inLine = fixedPoint({
  f: async (a?: object | void) => a,
});

const obj = {
  hello: 1,
  hi: "string",
  nullish: null,
  arr: [1, 2, 3, 4],
};

const { terminateAll, callFunction, send } = createThreadPool(
  { threads: 4 },
)({
  inLine,
});
if (isMain) {
  boxplot(async () => {
    group("worker", () => {
      summary(() => {
        bench(" 4 thread -> 40", async () => {
          const arr = [
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
            toResolve(obj),
          ];

          send();

          await Promise.all(arr);
        });
      });
    });

    group("knitting", () => {
      summary(() => {
        bench(" 4 thread -> 40", async () => {
          const arr = [
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
            callFunction.inLine(obj),
          ];

          send();

          await Promise.all(arr);
        });
      });
    });
  });
  await mitataRun({
    format: "markdown",
  });
  await terminateAllWorkers();
  await terminateAll();
}
