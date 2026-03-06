import { bench, do_not_optimize, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { format, print } from "./ulti/json-parse.ts";

const BATCH_SIZES = [1, 10, 100] as const;
const WARMUP = 50;
const WARMUP_N1 = 200;
const PAYLOAD_BYTES = 1024 * 1024;
const PAYLOAD_INITIAL_BYTES = 16 * 1024 * 1024;
const PAYLOAD_MAX_BYTES = 256 * 1024 * 1024;

const warmupIters = (batch: number) => (batch === 1 ? WARMUP_N1 : WARMUP);

export const echoString = task<string, string>({
  f: (value) => value,
});

export const echoBytes = task<Uint8Array, Uint8Array>({
  f: (value) => value,
});

export const echoF64 = task<number, number>({
  f: (value) => value,
});

let sink = 0;

const withWarmup = (
  n: number,
  runBatch: () => Promise<void>,
): (() => Promise<void>) => {
  let warmed = false;
  return async () => {
    if (!warmed) {
      const warmupCount = warmupIters(n);
      for (let i = 0; i < warmupCount; i++) await runBatch();
      warmed = true;
    }
    await runBatch();
  };
};

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

  const bytePayloads = [
    new Uint8Array(PAYLOAD_BYTES).fill(0xAB),
    new Uint8Array(PAYLOAD_BYTES).fill(0xBC),
    new Uint8Array(PAYLOAD_BYTES).fill(0xCD),
    new Uint8Array(PAYLOAD_BYTES).fill(0xDE),
  ];

  group(`knitting large string (${PAYLOAD_BYTES} bytes)`, () => {
    for (const n of BATCH_SIZES) {
      let turn = 0;
      const runBatch = async () => {
        const jobs = new Array<Promise<string>>(n);
        for (let j = 0; j < n; j++) {
          const index = (turn + j) % stringPayloads.length;
          jobs[j] = pool.call.echoString(stringPayloads[index]!);
        }
        const values = await Promise.all(jobs);
        for (const value of values) sink ^= value.length;
        turn++;
      };

      bench(`n=${n}`, withWarmup(n, runBatch));
    }
  });

  group("knitting number f64 (8 bytes)", () => {
    for (const n of BATCH_SIZES) {
      const runBatch = async () => {
        const jobs = Array.from({ length: n }, () => pool.call.echoF64(42));
        const values = await Promise.all(jobs);
        for (const value of values) sink ^= value | 0;
      };

      bench(`n=${n}`, withWarmup(n, runBatch));
    }
  });

  group(`knitting Uint8Array (${PAYLOAD_BYTES} bytes)`, () => {
    for (const n of BATCH_SIZES) {
      let turn = 0;
      const runBatch = async () => {
        const jobs = new Array<Promise<Uint8Array>>(n);
        for (let j = 0; j < n; j++) {
          const index = (turn + j) % bytePayloads.length;
          jobs[j] = pool.call.echoBytes(bytePayloads[index]!);
        }
        const values = await Promise.all(jobs);
        for (const value of values) sink ^= value.byteLength;
        turn++;
      };

      bench(`n=${n}`, withWarmup(n, runBatch));
    }
  });

  try {
    await mitataRun({ format, print });
  } finally {
    await pool.shutdown();
  }

  if (sink === Number.MIN_SAFE_INTEGER) {
    console.log("unreachable", sink);
  }
}
