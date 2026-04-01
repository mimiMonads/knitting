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
  const isJsonOutput = process.argv.includes("--json");
  const sizes = [1, 100];
  const toFilter = (value: string | undefined) => value?.trim().toLowerCase();
  const variantFilter = toFilter(process.env.TYPES_KNITTING_VARIANT);
  const kindFilter = toFilter(process.env.TYPES_KNITTING_KIND);
  const caseFilter = toFilter(process.env.TYPES_KNITTING_CASE);
  const sizeFilterRaw = process.env.TYPES_KNITTING_SIZE;
  const sizeFilter = sizeFilterRaw == null
    ? undefined
    : Number.parseInt(sizeFilterRaw, 10);
  const variants = [
    {
      name: "default",
      pool: createPool({ threads: 1 })({ echo }),
    },
    {
      name: "shadowRefresh=always",
      pool: createPool({
        threads: 1,
        advance: {
          shadowRefresh: "always",
        },
      })({ echo }),
    },
  ] as const;
  const selectedVariants = variants.filter((variant) =>
    variantFilter == null || variant.name.toLowerCase().includes(variantFilter)
  );
  const selectedSizes = sizes.filter((size) =>
    sizeFilter == null || size === sizeFilter
  );
  const includeTypes = kindFilter == null || kindFilter === "types";
  const includePromiseArgs = kindFilter == null ||
    kindFilter === "promise" ||
    kindFilter === "promise-args";
  const matchesCase = (name: string) =>
    caseFilter == null || name.toLowerCase().includes(caseFilter);

  const runBatch = async (
    call: (value: unknown) => Promise<unknown>,
    n: number,
    payload: unknown,
  ) => {
    const jobs = Array.from({ length: n }, () => call(payload));
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
      if (name === "smallU8" || name === "largeU8") continue;
      console.log(`  ${name}: ${estimatePayloadBytes(payload)} bytes`);
    }
    console.log("");
  }

  for (const n of selectedSizes) {
    for (const variant of selectedVariants) {
      if (!includeTypes) continue;
      group(`knitting-types ${variant.name} ${n}`, () => {
        for (const [name, payload] of [...comparableCases, ...knittingOnlyCases]) {
          if (!matchesCase(name)) continue;
          bench(
            `${name} -> (${n})`,
            async () => await runBatch(variant.pool.call.echo, n, payload),
          );
        }
      });
    }
  }

  for (const n of selectedSizes) {
    for (const variant of selectedVariants) {
      if (!includePromiseArgs) continue;
      group(`knitting-promise-args ${variant.name} ${n}`, () => {
        for (const [name, payload] of promiseCases) {
          if (!matchesCase(name)) continue;
          bench(
            `${name} -> (${n})`,
            async () => await runBatch(variant.pool.call.echo, n, payload),
          );
        }
      });
    }
  }

  try {
    await mitataRun({ format, print });
  } finally {
    for (const variant of variants) {
      await variant.pool.shutdown();
    }
  }
}
