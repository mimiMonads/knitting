import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { format, print } from "./ulti/json-parse.ts";
import {
  createSharedTypePayloadCases,
  type BenchPayloadCase,
} from "./ulti/type-payloads.ts";

export const echo = task<unknown, unknown>({
  f: (value) => value,
});

const WARMUP = 25;
const WARMUP_N1 = 100;
const PRIMITIVE_CASE_NAMES = [
  "number",
  "boolean true",
  "boolean false",
  "undefined",
  "null",
] as const;

const toFilter = (value: string | undefined) => value?.trim().toLowerCase();
const warmupIters = (batch: number) => (batch === 1 ? WARMUP_N1 : WARMUP);

const selectPrimitiveCases = (): BenchPayloadCase[] => {
  const { comparableCases, knittingOnlyCases } = createSharedTypePayloadCases();
  const caseMap = new Map<string, unknown>([
    ...comparableCases,
    ...knittingOnlyCases,
  ]);

  return PRIMITIVE_CASE_NAMES.map((name) => {
    const payload = caseMap.get(name);
    if (payload === undefined && name !== "undefined") {
      throw new Error(`Missing primitive benchmark case: ${name}`);
    }
    return [name, payload] as const;
  });
};

if (isMain) {
  const sizeFilterRaw = process.env.PRIMITIVE_SHADOW_SIZE;
  const sizeFilter = sizeFilterRaw == null
    ? undefined
    : Number.parseInt(sizeFilterRaw, 10);
  const caseFilter = toFilter(process.env.PRIMITIVE_SHADOW_CASE);
  const variantFilter = toFilter(process.env.PRIMITIVE_SHADOW_VARIANT);
  const sizes = sizeFilter == null ? [1, 10 , 100] : [sizeFilter];
  const variants = [
        {
      name: "shadowRefresh=always",
      pool: createPool({
        threads: 1,
        advance: {
          shadowRefresh: "always",
        },
      })({ echo }),
    },
    {
      name: "shadowed",
      pool: createPool({ threads: 1 })({ echo }),
    },
  ] as const;
  const selectedVariants = variants.filter((variant) =>
    variantFilter == null || variant.name.toLowerCase().includes(variantFilter)
  );
  const primitiveCases = selectPrimitiveCases().filter(([name]) =>
    caseFilter == null || name.toLowerCase().includes(caseFilter)
  );

  const runBatch = async (
    call: (value: unknown) => Promise<unknown>,
    n: number,
    payload: unknown,
  ) => {
    const jobs = Array.from({ length: n }, () => call(payload));
    await Promise.all(jobs);
  };
  const warmSelectedCases = async () => {
    for (const n of sizes) {
      const warmupCount = warmupIters(n);
      for (const variant of selectedVariants) {
        for (const [, payload] of primitiveCases) {
          // Prime the same shadowing path so measured samples are less
          // sensitive to worker startup and allocator jitter.
          for (let i = 0; i < warmupCount; i++) {
            await runBatch(variant.pool.call.echo, n, payload);
          }
        }
      }
    }
  };

  for (const n of sizes) {
    for (const variant of selectedVariants) {
      group(`knitting-primitives ${variant.name} ${n}`, () => {
        for (const [name, payload] of primitiveCases) {
          bench(
            `${name} -> (${n})`,
            async () => await runBatch(variant.pool.call.echo, n, payload),
          );
        }
      });
    }
  }

  try {
    await warmSelectedCases();
    await mitataRun({ format, print });
  } finally {
    for (const variant of variants) {
      await variant.pool.shutdown();
    }
  }
}
