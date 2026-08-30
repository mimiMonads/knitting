import { createPool, isMain, task } from "../knitting.ts";
import { BufferReference, sharedBytes } from "../unsafe.ts";

/**
 * Head-to-head: borrowed arena returns versus moved BufferReference returns.
 *
 *   SAB_THREADS=1,4 INFLIGHT=1,16 WORKLOAD=set|fill \
 *     bun run bench/shared-return-vs-buffer-reference.ts
 *
 *   arena   `sharedBytes(n)` -- a region of the return payload arena. The task
 *           builds the result in shared memory; the frame is offset+length.
 *   ref     `BufferReference` -- the task builds on the heap, the buffer is
 *           pinned, and the host adopts or safely copies it before the worker
 *           releases its hold.
 *   sab     a fresh `SharedArrayBuffer` per call, copied into and returned. The
 *           existing SAB payload codec pins it and the host adopts it, so this
 *           is the "just make a SAB and pass it" baseline -- and the one that
 *           has no reuse at all: every call mints, pins and adopts, and the
 *           host's adopted-token map grows for the life of the pool.
 *
 * `copy` is the plain transport, included only as the shared baseline both are
 * trying to beat.
 *
 * Two axes matter for this comparison and neither shows up in a single number:
 * `INFLIGHT`, because BufferReference pays its FFI pin per call while the arena
 * amortises nothing but reuses everything, and `WORKLOAD`, because the arena
 * writes shared memory (which V8 does 2.4x-20x slower than heap) and
 * BufferReference does not.
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
  .split(",").map((e) => Number(e.trim())).filter((e) => e > 0);
// `sab` retains every buffer it mints, so a long run at a large size is a real
// memory cost rather than just a slow one. Both are tunable for that reason.
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

/** Baseline: an ordinary allocation, copied through the transport. */
export const copyReturn = task<number, Uint8Array>({
  f: (packed) =>
    produce(
      new Uint8Array(packed & BYTES_MASK),
      packed & BYTES_MASK,
      packed >>> BYTES_BITS,
    ),
});

/** Built in a borrowed arena region: neither side copies. */
export const arenaReturn = task<number, Uint8Array>({
  f: (packed) =>
    produce(
      sharedBytes(packed & BYTES_MASK),
      packed & BYTES_MASK,
      packed >>> BYTES_BITS,
    ),
});

/** A fresh SAB per call: mint, copy in, hand the whole buffer back. */
export const sabReturn = task<number, SharedArrayBuffer>({
  f: (packed) => {
    const bytes = packed & BYTES_MASK;
    const sab = new SharedArrayBuffer(bytes);
    produce(new Uint8Array(sab), bytes, packed >>> BYTES_BITS);
    return sab;
  },
});

/** Built on the heap, then pinned and shipped as a pointer. */
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
    .map((e) => Number(e.trim())).filter((e) => Number.isInteger(e) && e > 0);
  const inflightList = (env("INFLIGHT") ?? "1,16").split(",")
    .map((e) => Number(e.trim())).filter((e) => Number.isInteger(e) && e > 0);

  console.log(
    `runtime: ${runtimeName()}   ${ROUNDS} timed rounds, workload=${WORKLOAD}`,
  );

  for (const threads of threadList) {
    const tasks = { copyReturn, arenaReturn, refReturn, sabReturn };
    const pool = createPool({
      threads,
      payload: { payloadMaxByteLength: 128 * 1024 * 1024 },
    })(tasks);
    const mismatches = new Map<string, number>();

    for (const inflight of inflightList) {
      console.log(`\n=== threads: ${threads}, in flight: ${inflight} ===`);
      console.log(
        `${"size".padEnd(8)}${"copy".padStart(11)}${"arena".padStart(11)}` +
          `${"ref".padStart(11)}${"sab".padStart(11)}` +
          `${"arena/cp".padStart(10)}${"ref/cp".padStart(9)}` +
          `${"sab/cp".padStart(9)}${"arena:ref".padStart(12)}` +
          `${"arena:sab".padStart(11)}`,
      );
      console.log("-".repeat(95));

      for (const bytes of SIZES) {
        const variants: Array<[string, (p: number) => Promise<unknown>]> = [
          ["copy", (p) => pool.call.copyReturn(p)],
          ["arena", (p) => pool.call.arenaReturn(p)],
          ["ref", (p) => pool.call.refReturn(p)],
          ["sab", (p) => pool.call.sabReturn(p)],
        ];
        const samples = new Map(variants.map(([n]) => [n, [] as number[]]));

        let stamp = 1;
        for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
          for (const [name, call] of variants) {
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
        const med = (n: string) => pct(sorted.get(n)!, 0.5);
        const copy = med("copy");
        const arena = med("arena");
        const ref = med("ref");
        console.log(
          `${fmtBytes(bytes).padEnd(8)}${fmtNs(copy).padStart(11)}` +
            `${fmtNs(arena).padStart(11)}${fmtNs(ref).padStart(11)}` +
            `${fmtNs(med("sab")).padStart(11)}` +
            `${`${(copy / arena).toFixed(2)}x`.padStart(10)}` +
            `${`${(copy / ref).toFixed(2)}x`.padStart(9)}` +
            `${`${(copy / med("sab")).toFixed(2)}x`.padStart(9)}` +
            `${`${(ref / arena).toFixed(2)}x`.padStart(12)}` +
            `${`${(med("sab") / arena).toFixed(2)}x`.padStart(11)}`,
        );
        const spread = (n: string) => {
          const l = sorted.get(n)!;
          return `${fmtNs(pct(l, 0.1))}..${fmtNs(pct(l, 0.9))}`;
        };
        console.log(
          `        p10..p90  arena [${spread("arena")}]  ref [${
            spread("ref")
          }]  sab [${spread("sab")}]`,
        );
      }
    }

    await pool.shutdown();
    if (mismatches.size > 0) {
      console.log(
        `!! payload mismatches: ${
          [...mismatches].map(([n, c]) => `${n}=${c}`).join(" ")
        }`,
      );
    }
  }
}
