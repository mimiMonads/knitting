import { createPool, isMain, task } from "../knitting.ts";
import { BufferReference } from "../unsafe.ts";

/**
 * How fast is `BufferReference` at moving a buffer *into* a worker?
 *
 *   SAB_THREADS=1,4 INFLIGHT=1,16 SIZES=8192,... \
 *     bun run bench/buffer-reference-send.ts
 *
 * This is the direction `sharedBytes` deliberately does not cover -- borrowing a
 * task's arguments would let them expire while it runs -- so the alternatives
 * here are the plain copy and hand-managed SharedArrayBuffers.
 *
 *   copy      an ordinary `Uint8Array` argument, sent from a staging buffer the
 *             host reuses: the host writes it into the payload arena, the worker
 *             copies it back out
 *   copy/f    the same, from a buffer freshly allocated for each call. This is
 *             the like-for-like baseline: `BufferReference` *cannot* reuse a
 *             source, so comparing it against a reusing sender charges it an
 *             allocation its rival never pays. Which of the two baselines is
 *             yours depends on whether your bytes arrive in a buffer you already
 *             own or in a fresh one off a socket or a file read
 *   ref       `BufferReference`: the host pins the buffer and the worker adopts
 *             the pointer and materialises a view over it. Construction
 *             *detaches* the source, so the host cannot reuse a staging buffer
 *             and pays a fresh allocation per call -- that is counted here
 *   ref/raw   the same, except the worker never materialises: it only reads
 *             `byteLength`. Not a usable workload, but it separates transport
 *             cost from the adopt-and-view cost
 *   sab       a fresh `SharedArrayBuffer` per call. Zero-copy like `ref`, minus
 *             the move semantics, plus an adopt the host never gets back: the
 *             consumer's token cache grows for the life of the pool
 *   sab/warm  one `SharedArrayBuffer` reused for every call. The ceiling: the
 *             token is warm after the first send, so the frame is four words and
 *             the only per-call work is the host writing the bytes
 *   arena     `unsafe.SharedArgs` plus `pool.sharedArgBytes(n)`: the same
 *             borrowed-region path `sharedBytes` uses on returns, pointed at the
 *             request lane. The host builds the argument in the submit arena and
 *             the worker reads it in place
 *   arena/b   `SharedArgs` on, but the host hands over an ordinary fresh
 *             `Uint8Array`: only the worker's copy-out is skipped
 *
 * Every arm produces the same bytes and the worker checks them, so the numbers
 * include payload production on the host and a real read on the worker. The
 * return value is a single number, to keep the return lane out of the way.
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
  .split(",").map((e) => Number(e.trim())).filter((e) => e > 0);
const WARMUP_ROUNDS = Number(env("WARMUP") ?? 8);
const ROUNDS = Number(env("ROUNDS") ?? 25);
const WORKLOAD = env("WORKLOAD") ?? "set";

// ---------------------------------------------------------------------------
// Worker side: every arm reads the stamp back out, so no arm can win by not
// touching the bytes it was sent.
// ---------------------------------------------------------------------------

const stampOf = (bytes: Uint8Array): number => {
  const first = bytes[0]!;
  // Reading the last byte too means an arm cannot win by faulting in one page.
  return first === bytes[bytes.byteLength - 1] ? first : -1;
};

export const takeCopy = task<Uint8Array, number>({
  f: (bytes) => stampOf(bytes),
});

export const takeRef = task<BufferReference, number>({
  f: (ref) => stampOf(ref.toUint8Array()),
});

/** Transport only: never materialises, so it is a ceiling and not a workload. */
export const takeRefRaw = task<BufferReference, number>({
  f: (ref) => (ref.byteLength > 0 ? 1 : -1),
});

export const takeSab = task<SharedArrayBuffer, number>({
  f: (sab) => stampOf(new Uint8Array(sab)),
});

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

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

/** Stamp `bytes` of `out`, by whichever discipline is selected. */
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
  // Default to >=2 threads: `sharedArgBytes` needs the shared submit queue, and
  // a single-worker pool does not use it.
  const threadList = (env("SAB_THREADS") ?? "2,4").split(",")
    .map((e) => Number(e.trim())).filter((e) => Number.isInteger(e) && e > 0);
  const inflightList = (env("INFLIGHT") ?? "1,16").split(",")
    .map((e) => Number(e.trim())).filter((e) => Number.isInteger(e) && e > 0);

  console.log(
    `runtime: ${runtimeName()}   ${ROUNDS} timed rounds, workload=${WORKLOAD}`,
  );

  for (const threads of threadList) {
    const pool = createPool({
      threads,
      unsafe: { SharedArgs: true },
      payload: { payloadMaxByteLength: 128 * 1024 * 1024 },
    })({ takeCopy, takeRef, takeRefRaw, takeSab });
    // Without `SharedArgs` this is a plain allocation and the `arena` arm
    // collapses onto `copy/f`, which is exactly what the comparison needs.
    const argBytes = pool.sharedArgBytes;
    const mismatches = new Map<string, number>();

    for (const inflight of inflightList) {
      console.log(`\n=== threads: ${threads}, in flight: ${inflight} ===`);
      console.log(
        `${"size".padEnd(8)}${"copy".padStart(10)}${"copy/f".padStart(10)}` +
          `${"ref".padStart(10)}${"ref/raw".padStart(10)}${"sab".padStart(10)}` +
          `${"sab/warm".padStart(10)}${"arena".padStart(10)}${"arena/b".padStart(10)}` +
          `${"ref:copy/f".padStart(12)}${"arena:copy/f".padStart(14)}` +
          `${"arena:ref".padStart(11)}`,
      );
      console.log("-".repeat(117));

      for (const bytes of SIZES) {
        // One buffer the reusing arm keeps; the others must allocate per call,
        // either because the transport moves the source or because a fresh
        // identity is the thing being measured.
        const warmSab = new SharedArrayBuffer(bytes);
        const warmView = new Uint8Array(warmSab);
        const copySource = new Uint8Array(bytes);

        const variants: Array<[string, (stamp: number) => Promise<number>]> = [
          ["copy", (stamp) => pool.call.takeCopy(produce(copySource, stamp))],
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
          // Reusing one SAB across a *stealing* pool crashes the second worker
          // that receives it -- the host marks the token warm after the first
          // send, but each worker keeps its own adopted-token cache, so the peer
          // gets a four-word frame for a token it has never seen. Pre-existing,
          // reproducible at HEAD, unrelated to borrowed regions; the arm is
          // skipped rather than worked around so the bench does not hide it.
          ...(threads === 1
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
          for (const [name, call] of variants) {
            const jobs = new Array<Promise<number>>(inflight);
            const stamps = new Array<number>(inflight);
            const start = nowNs();
            for (let j = 0; j < inflight; j++) {
              stamp = (stamp % 250) + 1;
              stamps[j] = stamp;
              jobs[j] = call(stamp);
            }
            const seen = await Promise.all(jobs);
            const elapsed = nowNs() - start;
            for (let j = 0; j < inflight; j++) {
              // `sab/warm` reuses one buffer, so concurrent calls legitimately
              // see each other's stamp; only check that they saw a stamp.
              const ok = name === "sab/warm" || name === "ref/raw"
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
        const med = (n: string) =>
          sorted.has(n) ? pct(sorted.get(n)!, 0.5) : NaN;
        const copy = med("copy");
        const copyFresh = med("copy/f");
        const ref = med("ref");
        console.log(
          `${fmtBytes(bytes).padEnd(8)}${fmtNs(copy).padStart(10)}` +
            `${fmtNs(copyFresh).padStart(10)}${fmtNs(ref).padStart(10)}` +
            `${fmtNs(med("ref/raw")).padStart(10)}${fmtNs(med("sab")).padStart(10)}` +
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
        console.log(
          `        p10..p90  copy/f [${spread("copy/f")}]  ref [${
            spread("ref")
          }]  arena [${spread("arena")}]  arena/b [${spread("arena/b")}]`,
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
