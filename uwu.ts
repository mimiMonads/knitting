import { createPool, task, isMain } from "./knitting.ts";


const BATCH_SIZES = [1, 10, 100] as const;
const ITERATIONS = 500;
const WARMUP = 50;
const WARMUP_N1 = 200;
const PAYLOAD_BYTES = 1024 * 1024;
const PAYLOAD_INITIAL_BYTES = 16 * 1024 * 1024;
const PAYLOAD_MAX_BYTES = 256 * 1024 * 1024;
const BYTE_FILL_VALUES = [0xAB, 0xBC, 0xCD, 0xDE] as const;
const UINT8ARRAY_SIZE_SWEEP_BATCH = 100;
const UINT8ARRAY_SIZE_SWEEP_MIN_BYTES = 8;
const UINT8ARRAY_SIZE_SWEEP_MAX_BYTES = PAYLOAD_BYTES;
const LABEL_COLUMN_WIDTH = 10;

const warmupIters = (batch: number) => (batch === 1 ? WARMUP_N1 : WARMUP);
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
  Bun?: { version: string };
  Deno?: { version: { deno: string } };
  process?: {
    versions?: { node?: string };
    hrtime?: { bigint?: () => bigint };
  };
};

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
    `${columnLabel.padEnd(LABEL_COLUMN_WIDTH)} ${"avg".padStart(12)} ${"min".padStart(12)} ${"p75".padStart(12)} ${"p99".padStart(12)} ${"max".padStart(12)}`,
  );
  console.log("-".repeat(70));
};

const printStats = (label: string, samples: number[]): void => {
  samples.sort((a, b) => a - b);

  const len = samples.length;
  const avg = samples.reduce((sum, sample) => sum + sample, 0) / len;
  const min = samples[0]!;
  const p75 = samples[Math.floor((len * 75) / 100)]!;
  const p99 = samples[Math.floor((len * 99) / 100)]!;
  const max = samples[len - 1]!;

  console.log(
    `${label.padEnd(LABEL_COLUMN_WIDTH)} ${fmtNs(avg).padStart(12)} ${fmtNs(min).padStart(12)} ${fmtNs(p75).padStart(12)} ${fmtNs(p99).padStart(12)} ${fmtNs(max).padStart(12)}`,
  );
};

const makeBytePayloads = (bytes: number): Uint8Array[] =>
  BYTE_FILL_VALUES.map((fillValue) => new Uint8Array(bytes).fill(fillValue));

const makeEchoBytesBatch = (
  n: number,
  payloads: readonly Uint8Array[],
  echoBytes: (value: Uint8Array) => Promise<Uint8Array>,
): (() => Promise<void>) => {
  let turn = 0;

  return async () => {
    const jobs = new Array<Promise<Uint8Array>>(n);
    for (let j = 0; j < n; j++) {
      const index = (turn + j) % payloads.length;
      jobs[j] = echoBytes(payloads[index]!);
    }
    const values = await Promise.all(jobs);
    for (const value of values) sink ^= value.byteLength;
    turn++;
  };
};

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

const runBench = async (
  label: string,
  makeRunBatch: (n: number) => () => Promise<void>,
): Promise<void> => {
  printHeader(label);

  for (const n of BATCH_SIZES) {
    const warmup = warmupIters(n);
    const samples: number[] = [];
    const runBatch = makeRunBatch(n);

    for (let i = 0; i < ITERATIONS + warmup; i++) {
      const start = nowNs();
      await runBatch();
      const elapsedNs = Number(nowNs() - start);
      if (i >= warmup) samples.push(elapsedNs);
    }

    printStats(`n=${n}`, samples);
  }
};


export const echoString = (sink:string) => sink
export const echoBytes = task<Uint8Array, Uint8Array>({
  f: (value) => value,
});

export const echoF64 = task<number, number>({
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
  })({ echoString, echoBytes, echoF64 });

  const stringPayloads = [
    "x".repeat(PAYLOAD_BYTES),
    "y".repeat(PAYLOAD_BYTES),
    "z".repeat(PAYLOAD_BYTES),
    "w".repeat(PAYLOAD_BYTES),
  ];

  const bytePayloads = makeBytePayloads(PAYLOAD_BYTES);

  console.log("task: send payload -> worker echo -> return, join_all");
  console.log(
    `(whole-batch latency; warmup n=1: ${WARMUP_N1}, others: ${WARMUP})`,
  );
  console.log("(string/bytes use 4 payload variants rotated with index % 4)");

  try {

    // await runBench("knitting number f64 (8 bytes)", (n) => {
    //   return async () => {
    //     const jobs = Array.from({ length: n }, () => pool.call.echoF64(42));
    //     const values = await Promise.all(jobs);
    //     for (const value of values) sink ^= value | 0;
    //   };
    // });

    // await runBench(`knitting large string (${PAYLOAD_BYTES} bytes)`, (n) => {
    //   let turn = 0;

    //   return async () => {
    //     const jobs = new Array<Promise<string>>(n);
    //     for (let j = 0; j < n; j++) {
    //       const index = (turn + j) % stringPayloads.length;
    //       jobs[j] = pool.call.echoString(stringPayloads[index]!);
    //     }
    //     const values = await Promise.all(jobs);
    //     for (const value of values) sink ^= value.length;
    //     turn++;
    //   };
    // });


    // await runBench(`knitting Uint8Array (${PAYLOAD_BYTES} bytes)`, (n) =>
    //   makeEchoBytesBatch(n, bytePayloads, (value) => pool.call.echoBytes(value)),
    // );

    // printHeader(
    //   `knitting Uint8Array size sweep (batch=${UINT8ARRAY_SIZE_SWEEP_BATCH}, ${fmtBinaryBytes(UINT8ARRAY_SIZE_SWEEP_MIN_BYTES)} -> ${fmtBinaryBytes(UINT8ARRAY_SIZE_SWEEP_MAX_BYTES)})`,
    //   "size",
    // );

    const sizeSweepWarmup = warmupIters(UINT8ARRAY_SIZE_SWEEP_BATCH);
    for (const bytes of uint8ArraySizeSweepBytes) {
      const samples: number[] = [];
      const runBatch = makeEchoBytesBatch(
        UINT8ARRAY_SIZE_SWEEP_BATCH,
        makeBytePayloads(bytes),
        (value) => pool.call.echoBytes(value),
      );

      for (let i = 0; i < ITERATIONS + sizeSweepWarmup; i++) {
        const start = nowNs();
        await runBatch();
        const elapsedNs = Number(nowNs() - start);
        if (i >= sizeSweepWarmup) samples.push(elapsedNs);
      }

      printStats(fmtBinaryBytes(bytes), samples);
    }
  } finally {
    await pool.shutdown();
  }

  if (sink === Number.MIN_SAFE_INTEGER) {
    console.log("unreachable", sink);
  }
}