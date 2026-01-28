import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { shutdownWorkers, toResolve } from "./postmessage/single.ts";
import { format, print } from "./ulti/json-parse.ts";

export const inLine = task({
  f: (_: void) => {},
});

const { shutdown, call, send } = createPool(
  {},
)({ inLine });

if (isMain) {
  const sizes = [1, 10, 100, 1000];

  // ───────────────────────── knitting (call) ────────────────────
  group("knitting", () => {
    for (const n of sizes) {
      bench(`1 thread → (${n})`, async () => {
        await Promise.all(Array.from({ length: n }, () => call.inLine()));
      });
    }
  });

  // ───────────────────────── worker (toResolve) ─────────────────────────
  group("worker", () => {
    for (const n of sizes) {
      bench(`1 thread → (${n})`, async () => {
        const arr = Array.from({ length: n }, () => toResolve());
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
