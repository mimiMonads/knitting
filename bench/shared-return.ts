import { createPool, isMain, task } from "../knitting.ts";
import { BufferReference, sharedBytes } from "../unsafe.ts";

/** Compare copied, automatically borrowed, `sharedBytes`, and BufferReference returns.
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

/** Return an ordinary heap allocation. */
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
  const threadList = (env("SAB_THREADS") ?? "1,4").split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

  console.log(
    `runtime: ${runtimeName()}   ${BATCH} in flight, ${ROUNDS} timed rounds, ` +
      `workload=${WORKLOAD}`,
  );

  for (const threads of threadList) {
    const tasks = { plainReturn, sharedReturn, sharedNoFillReturn, refReturn };
    // Both pools stay alive and alternate every round, so drift lands on both.
    const copyPool = createPool({
      threads,
      unsafe: { SharedBytes: false },
    })(tasks);
    const borrowPool = createPool({
      threads,
      unsafe: { SharedBytes: true },
    })(tasks);
    const mismatches = new Map<string, number>();

    console.log(`\n=== threads: ${threads} ===`);
    console.log(
      `${"size".padEnd(8)}${"copy".padStart(11)}${"borrow".padStart(11)}` +
        `${"shared".padStart(11)}${"nofill".padStart(11)}${
          "bufref".padStart(11)
        }` +
        `${"bor/cp".padStart(9)}${"sh/cp".padStart(8)}${"nf/cp".padStart(8)}` +
        `${"ref/cp".padStart(9)}`,
    );
    console.log("-".repeat(90));

    try {
      for (const bytes of SIZES) {
        const variants: Array<[string, (p: number) => Promise<unknown>]> = [
          ["copy", (p) => copyPool.call.plainReturn(p)],
          ["borrow", (p) => borrowPool.call.plainReturn(p)],
          ["shared", (p) => borrowPool.call.sharedReturn(p)],
          ["nofill", (p) => borrowPool.call.sharedNoFillReturn(p)],
          ["bufref", (p) => borrowPool.call.refReturn(p)],
        ];
        const samples = new Map(variants.map(([n]) => [n, [] as number[]]));

        let stamp = 1;
        for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
          for (const [name, call] of variants) {
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
        const med = (n: string) => pct(sorted.get(n)!, 0.5);
        const copy = med("copy");
        console.log(
          `${fmtBytes(bytes).padEnd(8)}${fmtNs(copy).padStart(11)}` +
            `${fmtNs(med("borrow")).padStart(11)}` +
            `${fmtNs(med("shared")).padStart(11)}` +
            `${fmtNs(med("nofill")).padStart(11)}` +
            `${fmtNs(med("bufref")).padStart(11)}` +
            `${`${(copy / med("borrow")).toFixed(2)}x`.padStart(9)}` +
            `${`${(copy / med("shared")).toFixed(2)}x`.padStart(8)}` +
            `${`${(copy / med("nofill")).toFixed(2)}x`.padStart(8)}` +
            `${`${(copy / med("bufref")).toFixed(2)}x`.padStart(9)}`,
        );
        const spread = (n: string) => {
          const l = sorted.get(n)!;
          return `${fmtNs(pct(l, 0.1))}..${fmtNs(pct(l, 0.9))}`;
        };
        console.log(
          `        p10..p90  copy [${spread("copy")}]  borrow [${
            spread("borrow")
          }]  shared [${spread("shared")}]  nofill [${
            spread("nofill")
          }]  bufref [${spread("bufref")}]`,
        );
      }
    } finally {
      await copyPool.shutdown();
      await borrowPool.shutdown();
    }
    if (mismatches.size > 0) {
      console.log(
        `!! payload mismatches: ${
          [...mismatches].map(([n, c]) => `${n}=${c}`).join(" ")
        }`,
      );
    }
  }
}
