import { availableParallelism } from "node:os";
import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { processWorkerUsesIpc } from "../src/runtime/process-worker.ts";
import { RUNTIME } from "../src/common/runtime.ts";
import { createWorkerPool } from "./postmessage/single.ts";
import { format, parseJsonBench, print } from "./util/json-parse.ts";

/**
 * Scheduler/round-trip overhead at matched pool sizes. One worker is created
 * per requested core on both sides; the raw worker pool dispatches round-robin.
 *
 *   LATENCY_CORES=1,2,4 LATENCY_BATCHES=1,10,100,1000 \
 *     deno run -A bench/latency.ts --json
 *
 * Process doorbell A/B (only host/child pairs with a Node-compatible IPC
 * channel are accepted):
 *
 *   LATENCY_WORKER=process LATENCY_PROCESS_RUNTIME=node \
 *     LATENCY_DOORBELL=both LATENCY_CORES=1 LATENCY_BATCHES=1 \
 *     LATENCY_STALL_FREE_LOOPS=0 \
 *     node --no-warnings --experimental-transform-types bench/latency.ts
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

const processWorker = process.env.LATENCY_WORKER === "process";
const processRuntime: "node" | "bun" | "deno" =
  process.env.LATENCY_PROCESS_RUNTIME === "bun"
    ? "bun"
    : process.env.LATENCY_PROCESS_RUNTIME === "deno"
    ? "deno"
    : "node";
const stallFreeLoops = Math.max(
  0,
  Number(process.env.LATENCY_STALL_FREE_LOOPS ?? "0"),
);
const doorbellMode = process.env.LATENCY_DOORBELL ?? "both";
if (!["poll", "doorbell", "both"].includes(doorbellMode)) {
  throw new Error("LATENCY_DOORBELL must be poll, doorbell, or both");
}
const processDoorbellModes = doorbellMode === "poll"
  ? [false]
  : doorbellMode === "doorbell"
  ? [true]
  : [false, true];

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

  if (
    processWorker &&
    !processWorkerUsesIpc({ processRuntime })
  ) {
    throw new Error(
      `No IPC completion doorbell for ${RUNTIME} host -> ${processRuntime} process worker`,
    );
  }

  for (const threads of cores) {
    const knitting = processWorker
      ? processDoorbellModes.map((doorbell) => ({
        name: `knitting process ${processRuntime} (${doorbell ? "IPC doorbell" : "poll"})`,
        pool: createPool({
          threads,
          host: { doorbell, stallFreeLoops },
          worker: { runtime: "process", processRuntime },
        })({ inLine }),
      }))
      : [{
        name: "knitting",
        pool: createPool({ threads })({ inLine }),
      }];
    const worker = processWorker ? undefined : createWorkerPool(threads);

    try {
      for (const { name, pool } of knitting) {
        group(`${name} (${threads} worker${threads === 1 ? "" : "s"})`, () => {
          for (const size of sizes) {
            bench(`batch ${size}`, async () => {
              await Promise.all(
                Array.from({ length: size }, () => pool.call.inLine()),
              );
            });
          }
        });
      }

      if (worker !== undefined) {
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
      }
      await mitataRun({ format, print: benchmarkPrint });
    } finally {
      await Promise.all([
        ...knitting.map(({ pool }) => pool.shutdown()),
        worker?.shutdown(),
      ]);
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(jsonResults, null, 2));
  }
}
