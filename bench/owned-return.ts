// Compare the safe large-binary return paths.
//
//   deno run -A bench/owned-return.ts
//   bun run bench/owned-return.ts
//   node --experimental-transform-types bench/owned-return.ts
//
// Environment:
//   SIZES=65536,262144,1048576 BENCH_WARMUP=10 BENCH_ITERATIONS=100
//
// On thread workers, ordinary Uint8Array and ArrayBuffer returns at or above
// 256 KiB move automatically. Node adopts the V8 backing store; Deno and Bun
// take exactly one safe host-side copy before the worker drops its pin.
import { createPool, isMain, task } from "../knitting.ts";
import { BufferReference } from "../unsafe.ts";
import { getBufferReferenceCapabilities } from "../src/connections/buffer-reference-native.ts";

const globals = globalThis as typeof globalThis & {
  Bun?: { version: string };
  Deno?: {
    version: { deno: string };
    env: { get: (name: string) => string | undefined };
  };
  process?: {
    versions?: { node?: string };
    env?: Record<string, string | undefined>;
    argv?: string[];
  };
};

const env = (name: string): string | undefined =>
  globals.Deno?.env.get(name) ?? globals.process?.env?.[name];

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const sizes = (env("SIZES") ?? "65536,262144,1048576,4194304")
  .split(",")
  .map((entry) => Number(entry.trim()))
  .filter((entry) => Number.isSafeInteger(entry) && entry > 1);
const warmup = positiveInteger(env("BENCH_WARMUP"), 10);
const iterations = positiveInteger(env("BENCH_ITERATIONS"), 100);
const outputJson = globals.Deno?.args?.includes("--json") === true ||
  globals.process?.argv?.includes("--json") === true ||
  ((globalThis as typeof globalThis & { Bun?: { argv?: string[] } }).Bun?.argv
      ?.includes("--json") === true);

const runtimeName = (): string =>
  globals.Bun !== undefined
    ? `bun ${globals.Bun.version}`
    : globals.Deno !== undefined
    ? `deno ${globals.Deno.version.deno}`
    : `node ${globals.process?.versions?.node ?? "?"}`;

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${bytes / (1024 * 1024)} MiB`
    : `${bytes / 1024} KiB`;

const producedBytes = (size: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x63;
  bytes[size - 1] = 0xa5;
  return bytes;
};

/** Ordinary raw return: owned move on Node, one safe copy on Deno/Bun. */
export const returnUint8Array = task<number, Uint8Array>({
  f: (size) => producedBytes(size),
});

/** Same automatic path, exercising the top-level ArrayBuffer frame. */
export const returnArrayBuffer = task<number, ArrayBuffer>({
  f: (size) => producedBytes(size).buffer,
});

/** Explicit API: Node adopts, Deno/Bun copy before worker-side release. */
export const returnBufferReference = task<number, BufferReference>({
  f: (size) => new BufferReference(producedBytes(size)),
});

let checksum = 0;
const consume = (bytes: Uint8Array, expectedLength: number): void => {
  if (
    bytes.byteLength !== expectedLength || bytes[0] !== 0x63 ||
      bytes[bytes.byteLength - 1] !== 0xa5
  ) {
    throw new Error("returned bytes were not owned and intact");
  }
  checksum = (checksum + bytes[0] + bytes[bytes.byteLength - 1]) >>> 0;
};

type Variant = {
  readonly name: string;
  run: (size: number) => Promise<void>;
};

type ResultRow = {
  readonly size: number;
  readonly uint8ArrayMs: number;
  readonly arrayBufferMs: number;
  readonly bufferReferenceMs: number;
};

if (isMain) {
  const capabilities = getBufferReferenceCapabilities();
  const automaticMode = capabilities.supportsOwningAdopt
    ? "Node owned move for returns >= 256 KiB"
    : "moved, then one safe host copy for returns >= 256 KiB";
  const explicitReferenceMode = capabilities.supportsOwningAdopt
    ? "owning adopt"
    : "safe host-side copy";

  using pool = createPool({
    threads: 1,
    payload: {
      payloadMaxByteLength: 64 * 1024 * 1024,
      maxPayloadBytes: 8 * 1024 * 1024,
    },
  })({ returnUint8Array, returnArrayBuffer, returnBufferReference });

  const variants: readonly Variant[] = [
    {
      name: "uint8Array",
      run: async (size) => consume(await pool.call.returnUint8Array(size), size),
    },
    {
      name: "arrayBuffer",
      run: async (size) =>
        consume(new Uint8Array(await pool.call.returnArrayBuffer(size)), size),
    },
    {
      name: "bufferReference",
      run: async (size) => {
        const reference = await pool.call.returnBufferReference(size);
        try {
          consume(reference.toUint8Array(), size);
        } finally {
          reference.release();
        }
      },
    },
  ];

  const rows: ResultRow[] = [];
  for (const size of sizes) {
    for (let round = 0; round < warmup; round++) {
      for (const variant of variants) await variant.run(size);
    }

    const totalMs = new Map(variants.map(({ name }) => [name, 0]));
    for (let round = 0; round < iterations; round++) {
      // Rotate the order so scheduling drift is not charged to one variant.
      for (let offset = 0; offset < variants.length; offset++) {
        const variant = variants[(round + offset) % variants.length]!;
        const start = performance.now();
        await variant.run(size);
        totalMs.set(variant.name, totalMs.get(variant.name)! + performance.now() - start);
      }
    }

    rows.push({
      size,
      uint8ArrayMs: totalMs.get("uint8Array")! / iterations,
      arrayBufferMs: totalMs.get("arrayBuffer")! / iterations,
      bufferReferenceMs: totalMs.get("bufferReference")! / iterations,
    });
  }

  const report = {
    benchmark: "owned-return",
    runtime: runtimeName(),
    automaticRawReturn: automaticMode,
    explicitBufferReferenceReturn: explicitReferenceMode,
    warmup,
    iterations,
    checksum,
    rows,
  };

  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nowned binary return — ${report.runtime}`);
    console.log(`ordinary raw return: ${automaticMode}`);
    console.log(`explicit BufferReference: ${explicitReferenceMode}\n`);
    console.log("  size        Uint8Array   ArrayBuffer  BufferReference");
    for (const row of rows) {
      console.log(
        `  ${formatBytes(row.size).padEnd(10)}  ` +
          `${row.uint8ArrayMs.toFixed(3).padStart(10)} ms  ` +
          `${row.arrayBufferMs.toFixed(3).padStart(10)} ms  ` +
          `${row.bufferReferenceMs.toFixed(3).padStart(14)} ms`,
      );
    }
    console.log();
  }
}
