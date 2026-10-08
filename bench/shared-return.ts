import { createPool, isMain, task } from "../knitting.ts";
import { BufferReference, sharedBytes } from "../unsafe.ts";

/** Compare ordinary raw, `sharedBytes`, and BufferReference returns.
 * Run with `SAB_THREADS`, `WORKLOAD`, and the size constants to vary the load.
 */

const SIZES = [4096, 16384, 65536, 262144, 1048576] as const;
const BATCH = 16;
const WARMUP_ROUNDS = 10;
const ROUNDS = 30;
const BYTES_BITS = 21;
const BYTES_MASK = (1 << BYTES_BITS) - 1;

const g = globalThis as typeof globalThis & {
  Bun?: { version: string };
  Deno?: {
    version: { deno: string };
    env: { get: (k: string) => string | undefined };
  };
  process?: {
    versions?: { node?: string };
    env?: Record<string, string | undefined>;
    hrtime?: { bigint: () => bigint };
  };
};

const env = (name: string): string | undefined =>
  g.Deno?.env.get(name) ?? g.process?.env?.[name];

const outputJson = process.argv.includes("--json");
const log = (...args: unknown[]) => {
  if (!outputJson) console.log(...args);
};

const nowNs = (): number => {
  const hrtime = g.process?.hrtime?.bigint;
  return hrtime ? Number(hrtime()) : globalThis.performance.now() * 1e6;
};

const runtimeName = (): string =>
  g.Bun
    ? `bun ${g.Bun.version}`
    : g.Deno
    ? `deno ${g.Deno.version.deno}`
    : `node ${g.process?.versions?.node ?? "?"}`;

const WORKLOAD = env("WORKLOAD") ?? "set";

const sourceBySize = new Map<number, Uint8Array>();
const sourceFor = (bytes: number, stamp: number): Uint8Array => {
  let src = sourceBySize.get(bytes);
  if (src === undefined) {
    src = new Uint8Array(bytes);
    sourceBySize.set(bytes, src);
  }
  src[0] = stamp;
  src[bytes - 1] = stamp;
  return src;
};

/** Fill `out` according to the selected workload. */
const produce = (out: Uint8Array, bytes: number, stamp: number): Uint8Array => {
  if (WORKLOAD === "set") out.set(sourceFor(bytes, stamp));
  else out.fill(stamp);
  return out;
};

/** Return an ordinary heap allocation (owned move on Node; safe copy on Deno/Bun). */
export const plainReturn = task<number, Uint8Array>({
  f: (packed) =>
    produce(
      new Uint8Array(packed & BYTES_MASK),
      packed & BYTES_MASK,
      packed >>> BYTES_BITS,
    ),
});

/** Build the return directly in the shared arena. */
export const sharedReturn = task<number, Uint8Array>({
  f: (packed) =>
    produce(
      sharedBytes(packed & BYTES_MASK),
      packed & BYTES_MASK,
      packed >>> BYTES_BITS,
    ),
});

/** Build the return in the shared arena without zero-filling. */
export const sharedNoFillReturn = task<number, Uint8Array>({
  f: (packed) =>
    produce(
      sharedBytes(packed & BYTES_MASK, false),
      packed & BYTES_MASK,
      packed >>> BYTES_BITS,
    ),
});

/** Return a heap buffer through BufferReference. */
export const refReturn = task<number, BufferReference>({
  f: (packed) => {
    const bytes = packed & BYTES_MASK;
    return new BufferReference(
      produce(new Uint8Array(bytes), bytes, packed >>> BYTES_BITS),
    );
  },
});

const fmtNs = (ns: number): string =>
  ns >= 1000 ? `${(ns / 1000).toFixed(2)}us` : `${ns.toFixed(0)}ns`;
const fmtBytes = (b: number): string =>
  b >= 1048576 ? `${b / 1048576}MiB` : `${b / 1024}KiB`;
const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

if (isMain) {
  const rows: Array<Record<string, unknown>> = [];
  if (
    !Number.isSafeInteger(ROUNDS) || ROUNDS < 1 ||
    !Number.isSafeInteger(WARMUP_ROUNDS) || WARMUP_ROUNDS < 0
  ) {
    throw new Error("round counts must be integers: rounds >= 1, warmup >= 0");
  }
  if (!["set", "fill"].includes(WORKLOAD)) {
    throw new Error("WORKLOAD must be set or fill");
  }

  const threadList = (env("SAB_THREADS") ?? "1,4").split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

  if (threadList.length === 0) {
    throw new Error("SAB_THREADS must contain positive integers");
  }

  log(
    `runtime: ${runtimeName()}   ${BATCH} in flight, ${ROUNDS} timed rounds, ` +
      `workload=${WORKLOAD}`,
  );

  for (const threads of threadList) {
    const tasks = { plainReturn, sharedReturn, sharedNoFillReturn, refReturn };
    // Both pools stay alive and alternate every round, so drift lands on both.
    const rawPool = createPool({
      permission: { node: { allowAddons: true } },
      threads,
      unsafe: { SharedBytes: false },
    })(tasks);
    const sharedPool = createPool({
      permission: { node: { allowAddons: true } },
      threads,
      unsafe: { SharedBytes: true },
    })(tasks);
    const mismatches = new Map<string, number>();

    log(`\n=== threads: ${threads} ===`);
    log(
      `${"size".padEnd(8)}${"raw".padStart(11)}${"shared".padStart(11)}` +
        `${"nofill".padStart(11)}${"bufref".padStart(11)}` +
        `${"raw/sh".padStart(9)}${"raw/nf".padStart(8)}` +
        `${"raw/ref".padStart(9)}`,
    );
    log("-".repeat(78));

    try {
      for (const bytes of SIZES) {
        const variants: Array<[string, (p: number) => Promise<unknown>]> = [
          ["raw", (p) => rawPool.call.plainReturn(p)],
          ["shared", (p) => sharedPool.call.sharedReturn(p)],
          ["nofill", (p) => sharedPool.call.sharedNoFillReturn(p)],
          ["bufref", (p) => sharedPool.call.refReturn(p)],
        ];
        const samples = new Map(variants.map(([n]) => [n, [] as number[]]));

        let stamp = 1;
        for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
          for (let offset = 0; offset < variants.length; offset++) {
            const [name, call] = variants[(round + offset) % variants.length]!;
            const jobs = new Array<Promise<unknown>>(BATCH);
            const stamps = new Array<number>(BATCH);
            const start = nowNs();
            for (let j = 0; j < BATCH; j++) {
              stamp = (stamp % 250) + 1;
              stamps[j] = stamp;
              jobs[j] = call((stamp << BYTES_BITS) | bytes);
            }
            const values = await Promise.all(jobs);
            const elapsed = nowNs() - start;
            for (let j = 0; j < BATCH; j++) {
              const raw = values[j];
              const ref = raw instanceof BufferReference ? raw : undefined;
              const v = ref === undefined
                ? raw as Uint8Array
                : ref.toUint8Array();
              if (
                v.byteLength !== bytes || v[0] !== stamps[j] ||
                v[bytes - 1] !== stamps[j]
              ) {
                mismatches.set(name, (mismatches.get(name) ?? 0) + 1);
              }
              ref?.release();
            }
            if (round >= WARMUP_ROUNDS) {
              samples.get(name)!.push(elapsed / BATCH);
            }
          }
        }

        const sorted = new Map(
          [...samples].map(([n, l]) => [n, [...l].sort((a, b) => a - b)]),
        );
        rows.push({
          threads,
          inflight: BATCH,
          bytes,
          variants: Object.fromEntries(
            [...sorted].map(([name, samples]) => [name, {
              samples: samples.length,
              p10_ns_per_op: pct(samples, 0.1),
              p50_ns_per_op: pct(samples, 0.5),
              p90_ns_per_op: pct(samples, 0.9),
            }]),
          ),
        });
        const med = (n: string) => pct(sorted.get(n)!, 0.5);
        const raw = med("raw");
        log(
          `${fmtBytes(bytes).padEnd(8)}${fmtNs(raw).padStart(11)}` +
            `${fmtNs(med("shared")).padStart(11)}` +
            `${fmtNs(med("nofill")).padStart(11)}` +
            `${fmtNs(med("bufref")).padStart(11)}` +
            `${`${(raw / med("shared")).toFixed(2)}x`.padStart(9)}` +
            `${`${(raw / med("nofill")).toFixed(2)}x`.padStart(8)}` +
            `${`${(raw / med("bufref")).toFixed(2)}x`.padStart(9)}`,
        );
        const spread = (n: string) => {
          const l = sorted.get(n)!;
          return `${fmtNs(pct(l, 0.1))}..${fmtNs(pct(l, 0.9))}`;
        };
        log(
          `        p10..p90  raw [${spread("raw")}]  shared [${
            spread("shared")
          }]  nofill [${spread("nofill")}]  bufref [${spread("bufref")}]`,
        );
      }
    } finally {
      await rawPool.shutdown();
      await sharedPool.shutdown();
    }
    if (mismatches.size > 0) {
      throw new Error(
        `payload mismatches: ${
          [...mismatches].map(([name, count]) => `${name}=${count}`).join(" ")
        }`,
      );
    }
  }
  if (outputJson) {
    console.log(JSON.stringify(
      {
        benchmark: "shared-return",
        runtime: runtimeName(),
        workload: WORKLOAD,
        warmup: WARMUP_ROUNDS,
        rounds: ROUNDS,
        metric:
          "batch wall time divided by inflight; excludes host validation and release",
        rows,
      },
      null,
      2,
    ));
  }
}
