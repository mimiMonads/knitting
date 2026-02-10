import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { TaskIndex } from "../src/memory/lock.ts";
import { format, print } from "./ulti/json-parse.ts";
import {
  createSharedTypePayloadCases,
  createStaticBoundaryCases,
  createStringLength3xCases,
  createPayloadSizeCases,
  estimatePayloadBytes,
} from "./ulti/type-payloads.ts";

export const echo = task<unknown, unknown>({
  f: (value) => value,
});

if (isMain) {
  const { call, shutdown } = createPool({ threads: 1 })({ echo });
  const isJsonOutput = process.argv.includes("--json");
  const sizes = [1, 100];

  const runBatch = async (n: number, payload: unknown) => {
    const jobs = Array.from({ length: n }, () => call.echo(payload));
    await Promise.all(jobs);
  };

  const { comparableCases, knittingOnlyCases, promiseCases } = createSharedTypePayloadCases();
  const staticMaxBytes =
    (TaskIndex.TotalBuff - TaskIndex.Size) * Uint32Array.BYTES_PER_ELEMENT;
  const staticBoundaryCases = createStaticBoundaryCases(staticMaxBytes);
  const stringLengthCases = createStringLength3xCases();
  const payloadSizeCases = createPayloadSizeCases(comparableCases, staticMaxBytes);

  if (!isJsonOutput) {
    console.log("payload sizes (approx bytes):");
    for (const [name, payload] of payloadSizeCases) {
      console.log(`  ${name}: ${estimatePayloadBytes(payload)} bytes`);
    }
  }

  for (const n of sizes) {
    group("knitting-types " + n, () => {
      for (const [name, payload] of [...comparableCases, ...knittingOnlyCases]) {
        bench(`${name} -> (${n})`, async () => await runBatch(n, payload));
      }
    });
  }

  for (const n of sizes) {
    group("knitting-promise-args " + n, () => {
      for (const [name, payload] of promiseCases) {
        bench(`${name} -> (${n})`, async () => await runBatch(n, payload));
      }
    });
  }

  for (const n of sizes) {
    group("knitting-static-vs-allocator " + n, () => {
      for (const [name, payload] of staticBoundaryCases) {
        bench(`${name} -> (${n})`, async () => await runBatch(n, payload));
      }
    });
  }

  for (const n of sizes) {
    group("knitting-string-length-3x-check " + n, () => {
      for (const [name, payload] of stringLengthCases) {
        bench(`${name} -> (${n})`, async () => await runBatch(n, payload));
      }
    });
  }

  await mitataRun({ format, print });
  await shutdown();
}
