import { availableParallelism } from "node:os";
import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { createWorkerPool } from "./postmessage/single.ts";
import { format, parseJsonBench, print } from "./util/json-parse.ts";

/**
 * Scheduler/round-trip overhead at matched pool sizes. One worker is created
 * per requested core on both sides; the raw worker pool dispatches round-robin.
 *
 *   LATENCY_CORES=1,2,4 LATENCY_BATCHES=1,10,100,1000 \
 *     deno run -A bench/latency.ts --json
 *
 * The task is intentionally empty, so additional cores are not expected to
 * improve throughput; this isolates scheduling and transport overhead.
 */
export const inLine = task({
  f: (_: void) => {},
});

const readPositiveIntegers = (value: string, label: string): number[] => {
  const values = value.split(",").map((entry) => Number(entry.trim()));
  if (
    values.length === 0 ||
    values.some((entry) => !Number.isSafeInteger(entry) || entry < 1)
  ) {
    throw new Error(
      `${label} must be a comma-separated list of positive integers`,
    );
  }
  return [...new Set(values)];
};

if (isMain) {
  const parallelism = availableParallelism();
  const defaultCores = [1, 2, 4].filter((cores) => cores <= parallelism);
  const cores = readPositiveIntegers(
    process.env.LATENCY_CORES ?? defaultCores.join(","),
    "LATENCY_CORES",
  );
  const sizes = readPositiveIntegers(
    process.env.LATENCY_BATCHES ?? "1,10,100,1000",
    "LATENCY_BATCHES",
  );
  const jsonOutput = process.argv.includes("--json");
  const jsonResults: Record<string, unknown> = {};
  const benchmarkPrint = jsonOutput
    ? (jsonString: string) =>
      Object.assign(jsonResults, parseJsonBench(jsonString))
    : print;

  for (const threads of cores) {
    const knitting = createPool({ threads })({ inLine });
    const worker = createWorkerPool(threads);

    try {
      group(`knitting (${threads} worker${threads === 1 ? "" : "s"})`, () => {
        for (const size of sizes) {
          bench(`batch ${size}`, async () => {
            await Promise.all(
              Array.from({ length: size }, () => knitting.call.inLine()),
            );
          });
        }
      });

      group(
        `worker_threads (${threads} worker${threads === 1 ? "" : "s"})`,
        () => {
          for (const size of sizes) {
            bench(`batch ${size}`, async () => {
              await Promise.all(
                Array.from({ length: size }, () => worker.call()),
              );
            });
          }
        },
      );
      await mitataRun({ format, print: benchmarkPrint });
    } finally {
      await Promise.all([knitting.shutdown(), worker.shutdown()]);
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(jsonResults, null, 2));
  }
}
