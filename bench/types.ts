import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { shutdownWorkers, toResolve } from "./postmessage/single.ts";
import { format, print } from "./ulti/json-parse.ts";
import { createSharedTypePayloadCases } from "./ulti/type-payloads.ts";

export const echo = task<unknown, unknown>({ f: (value) => value });

if (isMain) {
  const { call, shutdown } = createPool({})({ echo });
  const sizes = [1, 100];
  const { comparableCases } = createSharedTypePayloadCases();

  const runKnitting = async (n: number, payload: unknown) => {
    const jobs = Array.from({ length: n }, () => call.echo(payload));
    await Promise.all(jobs);
  };

  const runWorker = async (n: number, payload: unknown) => {
    const jobs = Array.from({ length: n }, () => toResolve(payload));
    await Promise.all(jobs);
  };

  for (const n of sizes) {
    group("knitting " + n, () => {
      for (const [name, payload] of comparableCases) {
        bench(`${name} -> (${n})`, async () => await runKnitting(n, payload));
      }
    });
  }

  for (const n of sizes) {
    group("worker " + n, () => {
      for (const [name, payload] of comparableCases) {
        bench(`${name} -> (${n})`, async () => await runWorker(n, payload));
      }
    });
  }

  await mitataRun({ format, print });
  await shutdown();
  await shutdownWorkers();
}
