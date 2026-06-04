// Benchmark one-way BufferReference transport against Uint8Array payload copies.
//
//   deno run -A bench/buffer-reference.ts
//   bun run bench/buffer-reference.ts
//   node --experimental-transform-types bench/buffer-reference.ts
//
// Return tests opt into borrowed refs so Deno/Bun measure pointer metadata.
import { createPool, isMain, task } from "../knitting.ts";
import { BufferReference } from "../unsafe.ts";

const SIZES = [
  8 * 1024,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
  8 * 1024 * 1024,
] as const;
const WARMUP = 20;
const ITERATIONS = 200;

const runtimeArgs = (): readonly string[] =>
  (globalThis as typeof globalThis & {
    Deno?: { args?: string[] };
    Bun?: { argv?: string[] };
    process?: { argv?: string[] };
  }).Deno?.args ??
    (globalThis as { Bun?: { argv?: string[] } }).Bun?.argv ??
    (globalThis as { process?: { argv?: string[] } }).process?.argv ??
    [];

const outputJson = runtimeArgs().includes("--json");

const fmtBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`;

type BenchRow = { size: number; refMs: number; copyMs: number };
type DirectionRow = { size: number; sendMs: number; returnMs: number };

// The tasks touch or allocate only enough to isolate transport cost.
export const sendRef = task<BufferReference, void>({
  f: (ref) => {
    void ref.byteLength;
  },
});

export const sendCopy = task<Uint8Array, void>({
  f: (bytes) => {
    void bytes.byteLength;
  },
});

export const returnRef = task<number, BufferReference>({
  f: (size) => new BufferReference(new ArrayBuffer(size)),
});

export const returnCopy = task<number, Uint8Array>({
  f: (size) => new Uint8Array(size),
});

const timeAvgMs = async (
  iterations: number,
  run: () => Promise<unknown>,
): Promise<number> => {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await run();
  return (performance.now() - t0) / iterations;
};

if (isMain) {
  using pool = createPool({
    threads: 1,
    unsafe: {
      BufferReferenceReturn: "borrow",
    },
    payload: {
      payloadMaxByteLength: 64 * 1024 * 1024,
      maxPayloadBytes: 8 * 1024 * 1024,
    },
  })({ sendRef, sendCopy, returnRef, returnCopy });

  const runDirection = async (): Promise<DirectionRow[]> => {
    const results: DirectionRow[] = [];

    for (const size of SIZES) {
      const sendRun = () =>
        pool.call.sendRef(new BufferReference(new Uint8Array(size)));
      const returnRun = async () => {
        const ref = await pool.call.returnRef(size);
        ref.release();
      };

      for (let i = 0; i < WARMUP; i++) {
        await sendRun();
        await returnRun();
      }

      let sendTotalMs = 0;
      let returnTotalMs = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        if ((i & 1) === 0) {
          const sendStart = performance.now();
          await sendRun();
          sendTotalMs += performance.now() - sendStart;

          const returnStart = performance.now();
          await returnRun();
          returnTotalMs += performance.now() - returnStart;
        } else {
          const returnStart = performance.now();
          await returnRun();
          returnTotalMs += performance.now() - returnStart;

          const sendStart = performance.now();
          await sendRun();
          sendTotalMs += performance.now() - sendStart;
        }
      }

      const sendMs = sendTotalMs / ITERATIONS;
      const returnMs = returnTotalMs / ITERATIONS;
      results.push({ size, sendMs, returnMs });
    }

    return results;
  };

  const runScenario = async (
    refRunForSize: (size: number) => Promise<void>,
    copyRunForSize: (size: number) => Promise<unknown>,
  ): Promise<BenchRow[]> => {
    const results: BenchRow[] = [];

    for (const size of SIZES) {
      const refRun = () => refRunForSize(size);
      const copyRun = () => copyRunForSize(size);

      for (let i = 0; i < WARMUP; i++) {
        await refRun();
        await copyRun();
      }

      const refMs = await timeAvgMs(ITERATIONS, refRun);
      const copyMs = await timeAvgMs(ITERATIONS, copyRun);
      results.push({ size, refMs, copyMs });
    }

    return results;
  };

  const directionResults = await runDirection();

  const scenarios: Array<{
    name: string;
    title: string;
    results: BenchRow[];
  }> = [
    {
      name: "send-only-transport",
      title: "send-only transport (host -> worker)",
      results: await runScenario(
        async (size) => {
          await pool.call.sendRef(
            new BufferReference(new Uint8Array(size)),
          );
        },
        (size) => pool.call.sendCopy(new Uint8Array(size)),
      ),
    },
    {
      name: "return-only-transport",
      title: "return-only transport (worker allocates, transport returns)",
      results: await runScenario(
        async (size) => {
          const ref = await pool.call.returnRef(size);
          ref.release();
        },
        (size) => pool.call.returnCopy(size),
      ),
    },
  ];

  if (outputJson) {
    console.log(
      JSON.stringify(
        {
          benchmark: "buffer-reference",
          mode: "one-way",
          warmup: WARMUP,
          iterations: ITERATIONS,
          directionResults,
          scenarios,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("\nbuffer-reference direction only (avg per call)\n");
    console.log("  size        send           return       return/send");
    for (const { size, sendMs, returnMs } of directionResults) {
      const ratio = (returnMs / sendMs).toFixed(2);
      console.log(
        `  ${fmtBytes(size).padEnd(10)}  ${
          sendMs.toFixed(3).padStart(10)
        } ms  ` +
          `${returnMs.toFixed(3).padStart(10)} ms  ${ratio.padStart(8)}x`,
      );
    }

    for (const { title, results } of scenarios) {
      console.log(`\nbuffer-reference ${title} (avg per call)\n`);
      console.log("  size        BufferReference   Uint8Array copy   speedup");
      for (const { size, refMs, copyMs } of results) {
        const speedup = (copyMs / refMs).toFixed(2);
        console.log(
          `  ${fmtBytes(size).padEnd(10)}  ${
            refMs.toFixed(3).padStart(10)
          } ms  ` +
            `${copyMs.toFixed(3).padStart(12)} ms  ${speedup.padStart(6)}x`,
        );
      }
    }
    console.log();
  }
}
