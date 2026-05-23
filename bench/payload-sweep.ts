import { createPool, isMain, task } from "../knitting.ts";

const ITERATIONS = 500;
const WARMUP = 50;
const PAYLOAD_INITIAL_BYTES = 16 * 1024 * 1024;
const PAYLOAD_MAX_BYTES = 256 * 1024 * 1024;
const BYTE_FILL_VALUES = [0xab, 0xbc, 0xcd, 0xde] as const;
const UINT8ARRAY_SIZE_SWEEP_BATCH = 100;
const UINT8ARRAY_SIZE_SWEEP_MIN_BYTES = 8;
const UINT8ARRAY_SIZE_SWEEP_MAX_BYTES = 1024 * 1024;
const LABEL_COLUMN_WIDTH = 10;

const uint8ArraySizeSweepBytes = (() => {
  const sizes: number[] = [];
  for (
    let bytes = UINT8ARRAY_SIZE_SWEEP_MIN_BYTES;
    bytes <= UINT8ARRAY_SIZE_SWEEP_MAX_BYTES;
    bytes *= 2
  ) {
    sizes.push(bytes);
  }
  return sizes;
})();

const runtimeGlobals = globalThis as typeof globalThis & {
  Bun?: { argv?: string[]; version: string };
  Deno?: { args?: string[]; version: { deno: string } };
  process?: {
    argv?: string[];
    versions?: { node?: string };
    hrtime?: { bigint?: () => bigint };
  };
};

type SweepStats = {
  avg: number;
  min: number;
  p75: number;
  p99: number;
  max: number;
};

type SweepResult = {
  name: string;
  sizeBytes: number;
  stats: SweepStats;
};

const runtimeArgs = (): readonly string[] =>
  runtimeGlobals.Deno?.args ??
    runtimeGlobals.Bun?.argv ??
    runtimeGlobals.process?.argv ??
    [];

const outputJson = runtimeArgs().includes("--json");

const fmtNs = (ns: number): string => {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)} \u00B5s`;
  return `${ns.toFixed(2)} ns`;
};

const fmtBinaryBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes >= 1024) return `${bytes / 1024} KiB`;
  return `${bytes} B`;
};

const printHeader = (label: string, columnLabel = "batch"): void => {
  console.log(`\n--- ${label} ---`);
  console.log(
    `${columnLabel.padEnd(LABEL_COLUMN_WIDTH)} ${"avg".padStart(12)} ${
      "min".padStart(12)
    } ${"p75".padStart(12)} ${"p99".padStart(12)} ${"max".padStart(12)}`,
  );
  console.log("-".repeat(70));
};

const measureStats = (samples: number[]): SweepStats => {
  samples.sort((a, b) => a - b);

  const len = samples.length;
  return {
    avg: samples.reduce((sum, sample) => sum + sample, 0) / len,
    min: samples[0]!,
    p75: samples[Math.floor((len * 75) / 100)]!,
    p99: samples[Math.floor((len * 99) / 100)]!,
    max: samples[len - 1]!,
  };
};

const printStats = (label: string, stats: SweepStats): void => {
  console.log(
    `${label.padEnd(LABEL_COLUMN_WIDTH)} ${fmtNs(stats.avg).padStart(12)} ${
      fmtNs(stats.min).padStart(12)
    } ${fmtNs(stats.p75).padStart(12)} ${fmtNs(stats.p99).padStart(12)} ${
      fmtNs(stats.max).padStart(12)
    }`,
  );
};

const makeBytePayloads = (bytes: number): Uint8Array[] =>
  BYTE_FILL_VALUES.map((fillValue) => new Uint8Array(bytes).fill(fillValue));

const runtimeName = (): string => {
  if (runtimeGlobals.Bun) return `bun ${runtimeGlobals.Bun.version}`;
  if (runtimeGlobals.Deno) return `deno ${runtimeGlobals.Deno.version.deno}`;
  if (runtimeGlobals.process?.versions?.node) {
    return `node ${runtimeGlobals.process.versions.node}`;
  }
  return "unknown";
};

const nowNs = (): bigint => {
  const hrtime = runtimeGlobals.process?.hrtime?.bigint;
  if (hrtime) return hrtime();
  return BigInt(Math.round(globalThis.performance.now() * 1_000_000));
};

export const echoBytes = task<Uint8Array, Uint8Array>({
  f: (value) => value,
});

let sink = 0;

if (isMain) {
  const pool = createPool({
    threads: 1,
    payload: {
      payloadInitialBytes: PAYLOAD_INITIAL_BYTES,
      payloadMaxByteLength: PAYLOAD_MAX_BYTES,
    },
  })({ echoBytes });

  const results: SweepResult[] = [];

  if (!outputJson) {
    console.log(`runtime: ${runtimeName()}`);
    console.log(
      `task: Uint8Array payload sweep, batch=${UINT8ARRAY_SIZE_SWEEP_BATCH}`,
    );
    printHeader(
      `${fmtBinaryBytes(UINT8ARRAY_SIZE_SWEEP_MIN_BYTES)} -> ${
        fmtBinaryBytes(UINT8ARRAY_SIZE_SWEEP_MAX_BYTES)
      }`,
      "size",
    );
  }

  try {
    for (const bytes of uint8ArraySizeSweepBytes) {
      let turn = 0;
      const payloads = makeBytePayloads(bytes);
      const samples: number[] = [];

      for (let i = 0; i < ITERATIONS + WARMUP; i++) {
        const start = nowNs();
        const jobs = new Array<Promise<Uint8Array>>(
          UINT8ARRAY_SIZE_SWEEP_BATCH,
        );
        for (let j = 0; j < UINT8ARRAY_SIZE_SWEEP_BATCH; j++) {
          const index = (turn + j) % payloads.length;
          jobs[j] = pool.call.echoBytes(payloads[index]!);
        }
        const values = await Promise.all(jobs);
        for (const value of values) sink ^= value.byteLength;
        turn++;

        const elapsedNs = Number(nowNs() - start);
        if (i >= WARMUP) samples.push(elapsedNs);
      }

      const label = fmtBinaryBytes(bytes);
      const stats = measureStats(samples);
      results.push({ name: label, sizeBytes: bytes, stats });
      if (!outputJson) printStats(label, stats);
    }
  } finally {
    await pool.shutdown();
  }

  if (outputJson) {
    console.log(JSON.stringify(
      {
        "knitting Uint8Array payload sweep": results,
        meta: {
          runtime: runtimeName(),
          batch: UINT8ARRAY_SIZE_SWEEP_BATCH,
          iterations: ITERATIONS,
          warmup: WARMUP,
          minBytes: UINT8ARRAY_SIZE_SWEEP_MIN_BYTES,
          maxBytes: UINT8ARRAY_SIZE_SWEEP_MAX_BYTES,
        },
      },
      null,
      2,
    ));
  }

  if (sink === Number.MIN_SAFE_INTEGER) {
    console.log("unreachable", sink);
  }
}
