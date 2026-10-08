import { createPool, isMain, task } from "../knitting.ts";
import { BufferReference, sharedBytes } from "../unsafe.ts";

/** Compare ordinary raw, arena-backed, SharedArrayBuffer, and BufferReference returns.
 * Vary `SAB_THREADS`, `INFLIGHT`, `SIZES`, and `WORKLOAD` to change the load.
 */

const DEFAULT_SIZES = [4096, 16384, 65536, 262144, 1048576, 4194304];
const BYTES_BITS = 24;
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
const SIZES = (env("SIZES") ?? DEFAULT_SIZES.join(","))
  .split(",").map((e) => Number(e.trim()));
// Fresh SAB returns retain one buffer per call; keep the run size bounded.
const WARMUP_ROUNDS = Number(env("WARMUP") ?? 8);
const ROUNDS = Number(env("ROUNDS") ?? 25);

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

const produce = (out: Uint8Array, bytes: number, stamp: number): Uint8Array => {
  if (WORKLOAD === "set") out.set(sourceFor(bytes, stamp));
  else out.fill(stamp);
  return out;
};

/** Ordinary heap allocation (owned move on Node; safe copy on Deno/Bun). */
export const rawReturn = task<number, Uint8Array>({
  f: (packed) =>
    produce(
      new Uint8Array(packed & BYTES_MASK),
      packed & BYTES_MASK,
      packed >>> BYTES_BITS,
    ),
});

/** Return bytes built in the shared arena. */
export const arenaReturn = task<number, Uint8Array>({
  f: (packed) =>
    produce(
      sharedBytes(packed & BYTES_MASK),
      packed & BYTES_MASK,
      packed >>> BYTES_BITS,
    ),
});

/** Return a fresh SharedArrayBuffer on every call. */
export const sabReturn = task<number, SharedArrayBuffer>({
  f: (packed) => {
    const bytes = packed & BYTES_MASK;
    const sab = new SharedArrayBuffer(bytes);
    produce(new Uint8Array(sab), bytes, packed >>> BYTES_BITS);
    return sab;
  },
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
  if (
    SIZES.length === 0 ||
    SIZES.some((bytes) =>
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > BYTES_MASK
    )
  ) {
    throw new Error(
      "SIZES must contain positive integer byte lengths within the packed input range",
    );
  }

  const threadList = (env("SAB_THREADS") ?? "1,4").split(",")
    .map((e) => Number(e.trim())).filter((e) => Number.isInteger(e) && e > 0);
  const inflightList = (env("INFLIGHT") ?? "1,16").split(",")
    .map((e) => Number(e.trim())).filter((e) => Number.isInteger(e) && e > 0);

  if (threadList.length === 0 || inflightList.length === 0) {
    throw new Error("SAB_THREADS and INFLIGHT must contain positive integers");
  }

  log(
    `runtime: ${runtimeName()}   ${ROUNDS} timed rounds, workload=${WORKLOAD}`,
  );

  for (const threads of threadList) {
    const tasks = { rawReturn, arenaReturn, refReturn, sabReturn };
    const pool = createPool({
      permission: { node: { allowAddons: true } },
      threads,
      payload: { payloadMaxByteLength: 128 * 1024 * 1024 },
      unsafe: { SharedBytes: true },
    })(tasks);
    const mismatches = new Map<string, number>();

    try {
      for (const inflight of inflightList) {
        log(`\n=== threads: ${threads}, in flight: ${inflight} ===`);
        log(
          `${"size".padEnd(8)}${"raw".padStart(11)}${"arena".padStart(11)}` +
            `${"ref".padStart(11)}${"sab".padStart(11)}` +
            `${"raw/arena".padStart(10)}${"raw/ref".padStart(9)}` +
            `${"raw/sab".padStart(9)}${"ref/arena".padStart(12)}` +
            `${"sab/arena".padStart(11)}`,
        );
        log("-".repeat(95));

        for (const bytes of SIZES) {
          const variants: Array<[string, (p: number) => Promise<unknown>]> = [
            ["raw", (p) => pool.call.rawReturn(p)],
            ["arena", (p) => pool.call.arenaReturn(p)],
            ["ref", (p) => pool.call.refReturn(p)],
            ["sab", (p) => pool.call.sabReturn(p)],
          ];
          const samples = new Map(variants.map(([n]) => [n, [] as number[]]));

          let stamp = 1;
          for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
            for (let offset = 0; offset < variants.length; offset++) {
              const [name, call] =
                variants[(round + offset) % variants.length]!;
              const jobs = new Array<Promise<unknown>>(inflight);
              const stamps = new Array<number>(inflight);
              const start = nowNs();
              for (let j = 0; j < inflight; j++) {
                stamp = (stamp % 250) + 1;
                stamps[j] = stamp;
                jobs[j] = call((stamp << BYTES_BITS) | bytes);
              }
              const values = await Promise.all(jobs);
              const elapsed = nowNs() - start;
              for (let j = 0; j < inflight; j++) {
                const raw = values[j];
                const ref = raw instanceof BufferReference ? raw : undefined;
                const v = ref !== undefined
                  ? ref.toUint8Array()
                  : raw instanceof Uint8Array
                  ? raw
                  : new Uint8Array(raw as ArrayBufferLike);
                if (
                  v.byteLength !== bytes || v[0] !== stamps[j] ||
                  v[bytes - 1] !== stamps[j]
                ) {
                  mismatches.set(name, (mismatches.get(name) ?? 0) + 1);
                }
                ref?.release();
              }
              if (round >= WARMUP_ROUNDS) {
                samples.get(name)!.push(elapsed / inflight);
              }
            }
          }

          const sorted = new Map(
            [...samples].map(([n, l]) => [n, [...l].sort((a, b) => a - b)]),
          );
          rows.push({
            threads,
            inflight: inflight,
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
          const arena = med("arena");
          const ref = med("ref");
          log(
            `${fmtBytes(bytes).padEnd(8)}${fmtNs(raw).padStart(11)}` +
              `${fmtNs(arena).padStart(11)}${fmtNs(ref).padStart(11)}` +
              `${fmtNs(med("sab")).padStart(11)}` +
              `${`${(raw / arena).toFixed(2)}x`.padStart(10)}` +
              `${`${(raw / ref).toFixed(2)}x`.padStart(9)}` +
              `${`${(raw / med("sab")).toFixed(2)}x`.padStart(9)}` +
              `${`${(ref / arena).toFixed(2)}x`.padStart(12)}` +
              `${`${(med("sab") / arena).toFixed(2)}x`.padStart(11)}`,
          );
          const spread = (n: string) => {
            const l = sorted.get(n)!;
            return `${fmtNs(pct(l, 0.1))}..${fmtNs(pct(l, 0.9))}`;
          };
          log(
            `        p10..p90  arena [${spread("arena")}]  ref [${
              spread("ref")
            }]  sab [${spread("sab")}]`,
          );
        }
      }
    } finally {
      await pool.shutdown();
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
        benchmark: "shared-return-vs-buffer-reference",
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
