import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { shutdownWorkers, toResolve } from "./postmessage/single.ts";
import { format, print } from "./ulti/json-parse.ts";

export const inLine = task({
  f: async (_: void) => {},
});

const { shutdown, call, fastCall, send } = createPool(
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

  // ───────────────────────── knitting (call) ────────────────────
  group("knitting", () => {
    bench("1 thread → 1", async () => {
      await fastCall.inLine();
    }).baseline(true);

    for (const n of sizes) {
      bench(`1 thread → (${n})`, async () => {
        const arr = Array.from({ length: n }, () => call.inLine());
        send();
        await Promise.all(arr);
      });
    }
  });

  await mitataRun({
    format,
    print,
  });
  await shutdownWorkers();
  await shutdown();
}
