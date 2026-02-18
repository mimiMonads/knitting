import { Buffer as NodeBuffer } from "node:buffer";

type AllocResult = {
  byteLength: number;
};

type Candidate = {
  name: string;
  alloc: (size: number) => AllocResult;
};

type Stats = {
  name: string;
  medianNs: number;
  meanNs: number;
  minNs: number;
  maxNs: number;
  gibPerSecMedian: number;
  rounds: number;
  iterations: number;
};

const envValue = (key: string): string | undefined => {
  const g = globalThis as {
    Deno?: { env?: { get?: (name: string) => string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  const denoValue = g.Deno?.env?.get?.(key);
  if (denoValue !== undefined) return denoValue;
  return g.process?.env?.[key];
};

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const parseSizes = (value: string | undefined): number[] => {
  if (!value) return [64, 1024, 65536, 1048576];
  const out = value
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  return out.length > 0 ? out : [64, 1024, 65536, 1048576];
};

const rounds = parsePositiveInt(envValue("ALLOC_ROUNDS"), 7);
const warmupIters = parsePositiveInt(envValue("ALLOC_WARMUP_ITERS"), 20000);
const targetBytesPerRound = parsePositiveInt(
  envValue("ALLOC_TARGET_BYTES"),
  256 * 1024 * 1024,
);
const minIters = parsePositiveInt(envValue("ALLOC_MIN_ITERS"), 2000);
const maxIters = parsePositiveInt(envValue("ALLOC_MAX_ITERS"), 5_000_000);
const sizes = parseSizes(envValue("ALLOC_SIZES"));

const candidates: Candidate[] = [
  {
    name: "Buffer.allocUnsafe",
    alloc: (size) => NodeBuffer.allocUnsafe(size),
  },
  {
    name: "new ArrayBuffer",
    alloc: (size) => new ArrayBuffer(size),
  },
  {
    name: "new Uint8Array",
    alloc: (size) => new Uint8Array(size),
  },
];

const asRuntimeString = () => {
  const g = globalThis as {
    Bun?: { version?: string };
    Deno?: { version?: { deno?: string } };
    process?: { versions?: { node?: string } };
  };
  if (typeof g.Bun?.version === "string") return `bun ${g.Bun.version}`;
  if (typeof g.Deno?.version?.deno === "string") return `deno ${g.Deno.version.deno}`;
  if (typeof g.process?.versions?.node === "string") return `node ${g.process.versions.node}`;
  return "unknown";
};

let sink = 0;

const gcIfAvailable = () => {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
};

const median = (numbers: number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return (sorted.length & 1) === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const mean = (numbers: number[]) =>
  numbers.reduce((acc, n) => acc + n, 0) / numbers.length;

const formatNs = (ns: number) => {
  if (ns < 1_000) return `${ns.toFixed(2)} ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} us`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
};

const formatPct = (pct: number) => `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;

const runCandidate = (candidate: Candidate, size: number, iterations: number): Stats => {
  const warmup = Math.min(warmupIters, Math.max(1, iterations >>> 2));
  for (let i = 0; i < warmup; i++) {
    sink ^= candidate.alloc(size).byteLength;
  }

  const perRoundNs: number[] = [];
  for (let round = 0; round < rounds; round++) {
    gcIfAvailable();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      sink ^= candidate.alloc(size).byteLength;
    }
    const end = performance.now();
    perRoundNs.push(((end - start) * 1e6) / iterations);
  }

  const medianNs = median(perRoundNs);
  const meanNs = mean(perRoundNs);
  const minNs = Math.min(...perRoundNs);
  const maxNs = Math.max(...perRoundNs);
  const gibPerSecMedian = (size / (1024 ** 3)) / (medianNs / 1e9);

  return {
    name: candidate.name,
    medianNs,
    meanNs,
    minNs,
    maxNs,
    gibPerSecMedian,
    rounds,
    iterations,
  };
};

console.log(`runtime: ${asRuntimeString()}`);
console.log(
  `rounds=${rounds}, warmupIters=${warmupIters}, targetBytesPerRound=${targetBytesPerRound}`,
);

for (const size of sizes) {
  const iterations = Math.max(
    minIters,
    Math.min(maxIters, Math.floor(targetBytesPerRound / size)),
  );

  const stats = candidates.map((candidate) => runCandidate(candidate, size, iterations));
  const fastest = stats.reduce((best, current) =>
    current.medianNs < best.medianNs ? current : best
  );

  console.log("");
  console.log(
    `size=${size} bytes, iterations=${iterations} per round, fastest=${fastest.name}`,
  );
  console.log(
    "name".padEnd(22) +
      "median".padStart(14) +
      "mean".padStart(14) +
      "min".padStart(14) +
      "max".padStart(14) +
      "GiB/s".padStart(12) +
      "delta".padStart(12),
  );

  for (const row of stats) {
    const deltaPct = ((row.medianNs / fastest.medianNs) - 1) * 100;
    console.log(
      row.name.padEnd(22) +
        formatNs(row.medianNs).padStart(14) +
        formatNs(row.meanNs).padStart(14) +
        formatNs(row.minNs).padStart(14) +
        formatNs(row.maxNs).padStart(14) +
        row.gibPerSecMedian.toFixed(2).padStart(12) +
        formatPct(deltaPct).padStart(12),
    );
  }
}

if (sink === Number.MIN_SAFE_INTEGER) {
  console.log("unreachable", sink);
}
