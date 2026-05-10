import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { ProcessSharedBuffer } from "../process-shared-buffer.ts";
import { TaskIndex } from "../src/memory/lock.ts";
import type { Args } from "../src/types.ts";
import { format, print } from "./ulti/json-parse.ts";
import {
  createPayloadSizeCases,
  createSharedTypePayloadCases,
  createStaticBoundaryCases,
  createStringLength3xCases,
  estimatePayloadBytes,
} from "./ulti/type-payloads.ts";

export const echo = task<Args, Args>({
  f: (value) => value,
});

export const readProcessSharedBufferMetadata = task<
  ProcessSharedBuffer,
  number
>({
  f: (buffer) => buffer.byteLength,
});

if (isMain) {
  const { call, shutdown } = createPool({ threads: 1 })({
    echo,
    readProcessSharedBufferMetadata,
  });
  const isJsonOutput = process.argv.includes("--json");
  const sizes = [1, 100];

  const runBatch = async (n: number, payload: Args | Promise<Args>) => {
    const jobs = Array.from({ length: n }, () => call.echo(payload));
    await Promise.all(jobs);
  };

  const loadProcessSharedBufferPrimitives = async () => {
    const runtime = globalThis as typeof globalThis & {
      Bun?: unknown;
      Deno?: unknown;
      process?: { versions?: { node?: string; bun?: string } };
    };

    if (runtime.Bun !== undefined || runtime.process?.versions?.bun) {
      const { createBunConnectionPrimitives } = await import(
        "../src/connections/bun.ts"
      );
      return createBunConnectionPrimitives();
    }

    if (runtime.Deno !== undefined) {
      const { createDenoConnectionPrimitives } = await import(
        "../src/connections/deno.ts"
      );
      return createDenoConnectionPrimitives();
    }

    return undefined;
  };

  const processSharedBufferPrimitives =
    await loadProcessSharedBufferPrimitives();
  const processSharedBuffer = ProcessSharedBuffer.create(
    64,
    processSharedBufferPrimitives,
  );
  let processSharedBufferSink = 0;
  const runProcessSharedBufferBatch = async (n: number) => {
    const jobs = Array.from(
      { length: n },
      () => call.readProcessSharedBufferMetadata(processSharedBuffer),
    );
    const values = await Promise.all(jobs);
    for (const value of values) processSharedBufferSink ^= value | 0;
  };

  const { comparableCases, knittingOnlyCases, promiseCases } =
    createSharedTypePayloadCases();
  const staticMaxBytes = (TaskIndex.TotalBuff - TaskIndex.Size) *
    Uint32Array.BYTES_PER_ELEMENT;
  const staticBoundaryCases = createStaticBoundaryCases(staticMaxBytes);
  const stringLengthCases = createStringLength3xCases();
  const payloadSizeCases = createPayloadSizeCases(
    comparableCases,
    staticMaxBytes,
  );

  if (!isJsonOutput) {
    console.log("payload sizes (approx bytes):");
    for (const [name, payload] of payloadSizeCases) {
      if (name === "smallU8" || name === "largeU8") continue;
      console.log(`  ${name}: ${estimatePayloadBytes(payload)} bytes`);
    }
    console.log("");
  }

  for (const n of sizes) {
    group("knitting-types " + n, () => {
      for (
        const [name, payload] of [...comparableCases, ...knittingOnlyCases]
      ) {
        bench(`${name} -> (${n})`, async () => await runBatch(n, payload));
      }
      bench(
        `ProcessSharedBuffer metadata -> (${n})`,
        async () => await runProcessSharedBufferBatch(n),
      );
    });
  }

  for (const n of sizes) {
    group("knitting-promise-args " + n, () => {
      for (const [name, payload] of promiseCases) {
        bench(`${name} -> (${n})`, async () => await runBatch(n, payload));
      }
    });
  }

  await mitataRun({ format, print });
  if (processSharedBufferSink === -1) console.log(processSharedBufferSink);
  await shutdown();
}
