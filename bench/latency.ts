import { bench, group, run as mitataRun } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { terminateAllWorkers, toResolve } from "./postmessage/single.ts";
import { format, print } from "./ulti/json-parse.ts";

export const inLine = fixedPoint({
  f: async (_: void) => {},
});

const { terminateAll, callFunction, fastCallFunction, send } = createThreadPool(
  {},
)({ inLine });

if (isMain) {
  const sizes = [10, 100, 1000];

  // ───────────────────────── worker (toResolve) ─────────────────────────
  group("worker", () => {
    bench("1 thread → (1)", async () => {
      await toResolve();
    });

    for (const n of sizes) {
      bench(`1 thread → (${n})`, async () => {
        const arr = Array.from({ length: n }, () => toResolve());
        send();
        await Promise.all(arr);
      });
    }
  });

  // ───────────────────────── knitting (callFunction) ────────────────────
  group("knitting", () => {
    bench("1 thread → 1", async () => {
      await fastCallFunction.inLine();
    }).baseline(true);

    for (const n of sizes) {
      bench(`1 thread → (${n})`, async () => {
        const arr = Array.from({ length: n }, () => callFunction.inLine());
        send();
        await Promise.all(arr);
      });
    }
  });

  await mitataRun({
    format,
    print,
  });
  await terminateAllWorkers();
  await terminateAll();
}
