import { createPool, isMain, task } from "../knitting.ts";

/**
 * What does the shipped auto-upgrade cost or save?
 *
 * Returns at or above the slab threshold are now copied into a pinned slab and
 * shipped to the host by pointer, instead of being copied out of the payload
 * arena on the host thread. The worker pays a memcpy it did not pay before; the
 * host stops paying one. This measures whether that trade is worth taking by
 * default, since it applies to every ordinary `Uint8Array` return.
 *
 *   SAB_THREADS=1,4 bun run bench/sab-auto-upgrade.ts
 *
 * Both pools stay alive and alternate every round, and the leading pool swaps
 * each round, so drift and GC land on both arms rather than on whichever ran
 * second. Reported as median with the 10th/90th percentile spread, because a
 * two-run block A/B on a 4-core laptop reliably manufactures phantom results.
 */

const SIZES = [4096, 16384, 65536, 262144, 1048576] as const;
const BATCH = 16;
const WARMUP_ROUNDS = 10;
const ROUNDS = 40;
const BYTES_BITS = 21;
const BYTES_MASK = (1 << BYTES_BITS) - 1;

const g = globalThis as typeof globalThis & {
  Bun?: { version: string };
  Deno?: { version: { deno: string }; env: { get: (k: string) => string | undefined } };
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

const runtimeName = (): string => {
  if (g.Bun) return `bun ${g.Bun.version}`;
  if (g.Deno) return `deno ${g.Deno.version.deno}`;
  return `node ${g.process?.versions?.node ?? "?"}`;
};

/** An ordinary return: nothing here knows the slab path exists. */
export const plainReturn = task<number, Uint8Array>({
  f: (packed) => {
    const bytes = packed & BYTES_MASK;
    const out = new Uint8Array(bytes);
    out[0] = packed >>> BYTES_BITS;
    out[bytes - 1] = packed >>> BYTES_BITS;
    return out;
  },
});

const fmtNs = (ns: number): string =>
  ns >= 1000 ? `${(ns / 1000).toFixed(2)}us` : `${ns.toFixed(0)}ns`;

const fmtBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)}MiB` : `${bytes / 1024}KiB`;

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

if (isMain) {
  const threadList = (env("SAB_THREADS") ?? "1,4")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

  console.log(
    `runtime: ${runtimeName()}   ${BATCH} in flight, ${ROUNDS} timed rounds`,
  );

  for (const threads of threadList) {
    // SAB_CONTROL=1 makes both arms identical, so any difference the table
    // still shows is the harness, not the feature.
    const control = env("SAB_CONTROL") === "1";
    const on = createPool(
      control ? { threads, unsafe: { SharedBytes: false } } : { threads },
    )({ plainReturn });
    const off = createPool({ threads, unsafe: { SharedBytes: false } })({
      plainReturn,
    });
    let mismatches = 0;

    console.log(`\n=== threads: ${threads} ===`);
    console.log(
      `${"size".padEnd(9)}${"off (copy)".padStart(12)}${"on (slab)".padStart(12)}` +
        `${"speedup".padStart(10)}   spread p10..p90`,
    );
    console.log("-".repeat(78));

    try {
      for (const bytes of SIZES) {
        const arms: Array<[string, typeof on]> = [["off", off], ["on", on]];
        const samples = new Map<string, number[]>([["off", []], ["on", []]]);

        let stamp = 1;
        for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
          // Swap which arm leads each round: whichever runs first pays for a
          // cold cache and whatever the other arm left behind.
          const order = round % 2 === 0 ? arms : [arms[1]!, arms[0]!];
          for (const [name, pool] of order) {
            const jobs = new Array<Promise<Uint8Array>>(BATCH);
            const stamps = new Array<number>(BATCH);
            const start = nowNs();
            for (let j = 0; j < BATCH; j++) {
              stamp = (stamp % 250) + 1;
              stamps[j] = stamp;
              jobs[j] = pool.call.plainReturn((stamp << BYTES_BITS) | bytes);
            }
            const values = await Promise.all(jobs);
            const elapsed = nowNs() - start;
            for (let j = 0; j < BATCH; j++) {
              const out = values[j]!;
              // Verify the whole trip, not just that something came back.
              if (out.byteLength !== bytes) mismatches++;
              else if (out[0] !== stamps[j] || out[bytes - 1] !== stamps[j]) {
                mismatches++;
              }
            }
            if (round >= WARMUP_ROUNDS) samples.get(name)!.push(elapsed / BATCH);
          }
        }

        const offS = [...samples.get("off")!].sort((a, b) => a - b);
        const onS = [...samples.get("on")!].sort((a, b) => a - b);
        const offMed = pct(offS, 0.5);
        const onMed = pct(onS, 0.5);
        console.log(
          `${fmtBytes(bytes).padEnd(9)}${fmtNs(offMed).padStart(12)}` +
            `${fmtNs(onMed).padStart(12)}` +
            `${(offMed / onMed).toFixed(2)}x`.padStart(10) +
            `   ${fmtNs(pct(offS, 0.1))}..${fmtNs(pct(offS, 0.9))} vs ` +
            `${fmtNs(pct(onS, 0.1))}..${fmtNs(pct(onS, 0.9))}`,
        );
      }
    } finally {
      await on.shutdown();
      await off.shutdown();
    }
    if (mismatches > 0) console.log(`!! ${mismatches} corrupt payloads`);
  }
}
