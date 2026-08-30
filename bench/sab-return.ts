import { createPool, isMain, task } from "../knitting.ts";
import { sharedBytes } from "../unsafe.ts";

/**
 * Ceiling check for borrowed SAB returns: what does the host stop paying when a
 * large return arrives by reference instead of being copied out of the payload
 * arena?
 *
 *   SAB_THREADS=1,4 bun run bench/sab-return.ts
 *
 * Three return shapes, interleaved round-robin so drift hits every variant
 * equally:
 *
 *   copy    worker returns a fresh Uint8Array -> host allocUnsafeSlow + memcpy
 *   upgrade worker builds the same fresh Uint8Array, the return is redirected
 *           into one of its pinned reused SABs -> host zero-copy alias. This is
 *           the encoder auto-upgrade: the worker still allocates and now also
 *           copies once, the host stops copying entirely.
 *   direct  worker writes straight into its own slab, no intermediate array ->
 *           the ceiling, and what user code returning a SAB already gets today.
 *   shared  the shipped path: `sharedBytes(n)` from the worker slab pool, with
 *           the release ring and the host's finalizer actually in play.
 *   fresh   worker mints a new SAB per call -> alloc + FFI pin + FFI adopt, and
 *           leaks, so it is capped to the small sizes.
 *
 * These are upper bounds, not an implementation: the ring is statically sized
 * past the in-flight batch, so nothing here pays for the release ring or the
 * finalizer that the real pool needs to decide when a slab is reusable.
 */

const SIZES = [512, 1024, 4096, 16384, 65536, 262144, 1048576] as const;
const FRESH_MAX_BYTES = 65536;
const BATCH = 16;

// The ring must be small enough that warmup touches every slab: a slab's first
// use pays a cold 8-word frame plus an FFI adopt, every later use is 4 words and
// a cache hit, and the steady state is what this measures.
const WARMUP_ROUNDS = 10;
const ROUNDS = 20;
const SLAB_RING = BATCH * 2;
const BYTES_BITS = 21;
const BYTES_MASK = (1 << BYTES_BITS) - 1;

const runtimeGlobals = globalThis as typeof globalThis & {
  Bun?: { version: string };
  Deno?: { version: { deno: string }; env: { get: (k: string) => string | undefined } };
  process?: { versions?: { node?: string }; env?: Record<string, string | undefined>; hrtime?: { bigint: () => bigint } };
};

const env = (name: string): string | undefined =>
  runtimeGlobals.Deno?.env.get(name) ?? runtimeGlobals.process?.env?.[name];

const nowNs = (): number => {
  const hrtime = runtimeGlobals.process?.hrtime?.bigint;
  return hrtime ? Number(hrtime()) : globalThis.performance.now() * 1e6;
};

const runtimeName = (): string => {
  if (runtimeGlobals.Bun) return `bun ${runtimeGlobals.Bun.version}`;
  if (runtimeGlobals.Deno) return `deno ${runtimeGlobals.Deno.version.deno}`;
  return `node ${runtimeGlobals.process?.versions?.node ?? "?"}`;
};

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

type SlabRing = { views: Uint8Array[]; next: number };
const ringsBySize = new Map<number, SlabRing>();

const ringFor = (bytes: number): SlabRing => {
  let ring = ringsBySize.get(bytes);
  if (ring === undefined) {
    const views: Uint8Array[] = [];
    for (let i = 0; i < SLAB_RING; i++) {
      views.push(new Uint8Array(new SharedArrayBuffer(bytes)));
    }
    ring = { views, next: 0 };
    ringsBySize.set(bytes, ring);
  }
  return ring;
};

export const returnCopy = task<number, Uint8Array>({
  f: (packed) => {
    const bytes = packed & BYTES_MASK;
    const out = new Uint8Array(bytes);
    out[0] = packed >>> BYTES_BITS;
    return out;
  },
});

/** Auto-upgrade: build the payload as usual, then copy it into a slab. */
export const returnUpgrade = task<number, SharedArrayBuffer>({
  f: (packed) => {
    const bytes = packed & BYTES_MASK;
    const out = new Uint8Array(bytes);
    out[0] = packed >>> BYTES_BITS;
    const ring = ringFor(bytes);
    const view = ring.views[ring.next]!;
    ring.next = (ring.next + 1) % SLAB_RING;
    view.set(out);
    return view.buffer as SharedArrayBuffer;
  },
});

/** Ceiling: the payload is produced in the slab, so nothing is ever copied. */
export const returnDirect = task<number, SharedArrayBuffer>({
  f: (packed) => {
    const bytes = packed & BYTES_MASK;
    const ring = ringFor(bytes);
    const view = ring.views[ring.next]!;
    ring.next = (ring.next + 1) % SLAB_RING;
    view[0] = packed >>> BYTES_BITS;
    return view.buffer as SharedArrayBuffer;
  },
});

/** The shipped path: pooled slab, release ring, host finalizer. */
export const returnShared = task<number, Uint8Array>({
  f: (packed) => {
    const out = sharedBytes(packed & BYTES_MASK);
    out[0] = packed >>> BYTES_BITS;
    return out;
  },
});

export const returnFresh = task<number, SharedArrayBuffer>({
  f: (packed) => {
    const bytes = packed & BYTES_MASK;
    const sab = new SharedArrayBuffer(bytes);
    new Uint8Array(sab)[0] = packed >>> BYTES_BITS;
    return sab;
  },
});

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

const firstByte = (value: unknown): number => {
  if (value instanceof Uint8Array) return value[0]!;
  return new Uint8Array(value as ArrayBuffer)[0]!;
};

const fmtNs = (ns: number): string =>
  ns >= 1000 ? `${(ns / 1000).toFixed(2)}us` : `${ns.toFixed(0)}ns`;

const fmtBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${bytes / (1024 * 1024)}MiB`
    : bytes >= 1024
    ? `${bytes / 1024}KiB`
    : `${bytes}B`;

const median = (sorted: number[]): number => sorted[sorted.length >> 1]!;

if (isMain) {
  const threadList = (env("SAB_THREADS") ?? "1,4")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

  console.log(
    `runtime: ${runtimeName()}   batch=${BATCH} in flight, ` +
      `${ROUNDS} timed rounds of ${BATCH} calls, slab ring=${SLAB_RING}`,
  );

  for (const threads of threadList) {
    const pool = createPool({ threads })({
      returnCopy,
      returnUpgrade,
      returnDirect,
      returnShared,
      returnFresh,
    });
    let mismatches = 0;

    console.log(`\n=== threads: ${threads} ===`);
    console.log(
      `${"size".padEnd(8)}${"copy".padStart(10)}${"upgrade".padStart(10)}` +
        `${"direct".padStart(10)}${"shared".padStart(10)}${"fresh".padStart(10)}` +
        `${"shared".padStart(10)}`,
    );
    console.log("-".repeat(70));

    try {
      for (const bytes of SIZES) {
        const withFresh = bytes <= FRESH_MAX_BYTES;
        const variants: Array<[string, (packed: number) => Promise<unknown>]> = [
          ["copy", (packed) => pool.call.returnCopy(packed)],
          ["upgrade", (packed) => pool.call.returnUpgrade(packed)],
          ["direct", (packed) => pool.call.returnDirect(packed)],
          ["shared", (packed) => pool.call.returnShared(packed)],
        ];
        if (withFresh) {
          variants.push(["fresh", (packed) => pool.call.returnFresh(packed)]);
        }
        const samples = new Map<string, number[]>(
          variants.map(([name]) => [name, []]),
        );

        let stamp = 1;
        for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
          // Interleaved: one round of each variant before the next round, so a
          // frequency step or a GC pause lands on all of them, not on one.
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
              if (firstByte(values[j]) !== stamps[j]) mismatches++;
            }
            if (round >= WARMUP_ROUNDS) {
              samples.get(name)!.push(elapsed / BATCH);
            }
          }
        }

        const stats = new Map<string, number[]>();
        for (const [name, list] of samples) {
          stats.set(name, [...list].sort((a, b) => a - b));
        }
        const copy = median(stats.get("copy")!);
        const upgrade = median(stats.get("upgrade")!);
        const direct = median(stats.get("direct")!);
        const shared = median(stats.get("shared")!);
        const fresh = withFresh ? median(stats.get("fresh")!) : undefined;

        console.log(
          `${fmtBytes(bytes).padEnd(8)}${fmtNs(copy).padStart(10)}` +
            `${fmtNs(upgrade).padStart(10)}${fmtNs(direct).padStart(10)}` +
            `${fmtNs(shared).padStart(10)}` +
            `${(fresh === undefined ? "-" : fmtNs(fresh)).padStart(10)}` +
            `${`${(copy / shared).toFixed(2)}x`.padStart(10)}`,
        );

        // Spread, so a single median is never read as the whole story.
        const spread = (name: string): string => {
          const list = stats.get(name)!;
          return `${fmtNs(list[0]!)}..${fmtNs(list[list.length - 1]!)}`;
        };
        console.log(
          `${"  copy".padEnd(8)}[${spread("copy")}]  ` +
            `direct [${spread("direct")}]  shared [${spread("shared")}]`,
        );
      }
    } finally {
      await pool.shutdown();
    }

    if (mismatches > 0) {
      console.log(`!! ${mismatches} payload stamp mismatches (aliasing)`);
    }
  }
}
