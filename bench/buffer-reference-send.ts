import { createPool, isMain, task } from "../knitting.ts";
import { BufferReference } from "../unsafe.ts";

/** Compare copy, BufferReference, SharedArrayBuffer, and shared-argument sends.
 * Vary `SAB_THREADS`, `INFLIGHT`, `SIZES`, and `WORKLOAD` to change the load.
 */

const DEFAULT_SIZES = [8192, 65536, 262144, 1048576, 4194304, 8388608];

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

const SIZES = (env("SIZES") ?? DEFAULT_SIZES.join(","))
  .split(",").map((e) => Number(e.trim()));
const WARMUP_ROUNDS = Number(env("WARMUP") ?? 8);
const ROUNDS = Number(env("ROUNDS") ?? 25);
const WORKLOAD = env("WORKLOAD") ?? "set";

// Worker side: every arm reads the stamp back out.

const stampOf = (bytes: Uint8Array): number => {
  const first = bytes[0]!;
  return first === bytes[bytes.byteLength - 1] ? first : -1;
};

export const takeCopy = task<Uint8Array, number>({
  f: (bytes) => stampOf(bytes),
});

export const takeRef = task<BufferReference, number>({
  f: (ref) => stampOf(ref.toUint8Array()),
});

/** Transport-only upper bound; the worker reads only the length. */
export const takeRefRaw = task<BufferReference, number>({
  f: (ref) => (ref.byteLength > 0 ? 1 : -1),
});

export const takeSab = task<SharedArrayBuffer, number>({
  f: (sab) => stampOf(new Uint8Array(sab)),
});

// Host side.

const fmtNs = (ns: number): string =>
  Number.isNaN(ns)
    ? "-"
    : ns >= 1000
    ? `${(ns / 1000).toFixed(2)}us`
    : `${ns.toFixed(0)}ns`;
const fmtBytes = (b: number): string =>
  b >= 1048576 ? `${b / 1048576}MiB` : `${b / 1024}KiB`;
const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

/** Fill `out` according to the selected workload. */
const produce = (out: Uint8Array, stamp: number): Uint8Array => {
  if (WORKLOAD === "set") {
    out[0] = stamp;
    out[out.byteLength - 1] = stamp;
  } else {
    out.fill(stamp);
  }
  return out;
};

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
    SIZES.some((bytes) => !Number.isSafeInteger(bytes) || bytes < 1)
  ) {
    throw new Error(
      "SIZES must contain positive integer byte lengths",
    );
  }

  // The arena variant requires the shared submit queue.
  const threadList = (env("SAB_THREADS") ?? "2,4").split(",")
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
    const pool = createPool({
      permission: { node: { allowAddons: true } },
      threads,
      unsafe: { SharedArgs: true },
      payload: { payloadMaxByteLength: 128 * 1024 * 1024 },
    })({ takeCopy, takeRef, takeRefRaw, takeSab });
    const argBytes = pool.sharedArgBytes;
    const mismatches = new Map<string, number>();

    try {
      for (const inflight of inflightList) {
        log(`\n=== threads: ${threads}, in flight: ${inflight} ===`);
        log(
          `${"size".padEnd(8)}${"copy".padStart(10)}${"copy/f".padStart(10)}` +
            `${"ref".padStart(10)}${"ref/raw".padStart(10)}${
              "sab".padStart(10)
            }` +
            `${"sab/warm".padStart(10)}${"arena".padStart(10)}${
              "arena/b".padStart(10)
            }` +
            `${"copy/f/ref".padStart(12)}${"copy/f/arena".padStart(14)}` +
            `${"ref/arena".padStart(11)}`,
        );
        log("-".repeat(117));

        for (const bytes of SIZES) {
          const warmSab = new SharedArrayBuffer(bytes);
          const warmView = new Uint8Array(warmSab);
          // Queued calls may encode later under back-pressure. Give each
          // in-flight call a reused source that stays unchanged until it settles.
          const copySources = Array.from(
            { length: inflight },
            () => new Uint8Array(bytes),
          );

          const variants: Array<
            [string, (stamp: number, index: number) => Promise<number>]
          > = [
            [
              "copy",
              (stamp, index) =>
                pool.call.takeCopy(produce(copySources[index]!, stamp)),
            ],
            [
              "copy/f",
              (stamp) =>
                pool.call.takeCopy(produce(new Uint8Array(bytes), stamp)),
            ],
            [
              "ref",
              (stamp) =>
                pool.call.takeRef(
                  new BufferReference(produce(new Uint8Array(bytes), stamp)),
                ),
            ],
            [
              "ref/raw",
              (stamp) =>
                pool.call.takeRefRaw(
                  new BufferReference(produce(new Uint8Array(bytes), stamp)),
                ),
            ],
            [
              "sab",
              (stamp) =>
                pool.call.takeSab(
                  produce(new Uint8Array(new SharedArrayBuffer(bytes)), stamp)
                    .buffer as SharedArrayBuffer,
                ),
            ],
            [
              "arena",
              (stamp) => pool.call.takeCopy(produce(argBytes(bytes), stamp)),
            ],
            [
              "arena/b",
              (stamp) =>
                pool.call.takeCopy(produce(new Uint8Array(bytes), stamp)),
            ],
            // Reusing one SAB is safe only with one call in flight: otherwise
            // later stamps overwrite bytes that earlier calls are still reading.
            // Keep the single-worker restriction for the local token cache.
            ...(threads === 1 && inflight === 1
              ? [[
                "sab/warm",
                (stamp: number) => {
                  produce(warmView, stamp);
                  return pool.call.takeSab(warmSab);
                },
              ] as [string, (stamp: number) => Promise<number>]]
              : []),
          ];
          const samples = new Map(variants.map(([n]) => [n, [] as number[]]));

          let stamp = 1;
          for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
            for (let offset = 0; offset < variants.length; offset++) {
              const [name, call] =
                variants[(round + offset) % variants.length]!;
              const jobs = new Array<Promise<number>>(inflight);
              const stamps = new Array<number>(inflight);
              const start = nowNs();
              for (let j = 0; j < inflight; j++) {
                stamp = (stamp % 250) + 1;
                stamps[j] = stamp;
                jobs[j] = call(stamp, j);
              }
              const seen = await Promise.all(jobs);
              const elapsed = nowNs() - start;
              for (let j = 0; j < inflight; j++) {
                const ok = name === "ref/raw"
                  ? seen[j]! > 0
                  : seen[j] === stamps[j];
                if (!ok) mismatches.set(name, (mismatches.get(name) ?? 0) + 1);
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
          const med = (n: string) =>
            sorted.has(n) ? pct(sorted.get(n)!, 0.5) : NaN;
          const copy = med("copy");
          const copyFresh = med("copy/f");
          const ref = med("ref");
          log(
            `${fmtBytes(bytes).padEnd(8)}${fmtNs(copy).padStart(10)}` +
              `${fmtNs(copyFresh).padStart(10)}${fmtNs(ref).padStart(10)}` +
              `${fmtNs(med("ref/raw")).padStart(10)}${
                fmtNs(med("sab")).padStart(10)
              }` +
              `${fmtNs(med("sab/warm")).padStart(10)}` +
              `${fmtNs(med("arena")).padStart(10)}` +
              `${fmtNs(med("arena/b")).padStart(10)}` +
              `${`${(copyFresh / ref).toFixed(2)}x`.padStart(12)}` +
              `${`${(copyFresh / med("arena")).toFixed(2)}x`.padStart(14)}` +
              `${`${(ref / med("arena")).toFixed(2)}x`.padStart(11)}`,
          );
          const spread = (n: string) => {
            const l = sorted.get(n);
            return l === undefined
              ? "-"
              : `${fmtNs(pct(l, 0.1))}..${fmtNs(pct(l, 0.9))}`;
          };
          log(
            `        p10..p90  copy/f [${spread("copy/f")}]  ref [${
              spread("ref")
            }]  arena [${spread("arena")}]  arena/b [${spread("arena/b")}]`,
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
        benchmark: "buffer-reference-send",
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
