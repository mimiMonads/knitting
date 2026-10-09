import { createPool, isMain, task } from "../../knitting.ts";
import { BufferReference } from "../../unsafe.ts";
import { bufferToString, stringToBuffer } from "../../utils.ts";
import { nativeStrings, stringBackend } from "./string-reference.mjs";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import process from "node:process";
import { callAutoString, callNativeString } from "./string-transport.ts";

// Node/Deno/Bun experiment; build the Node-API addon first (bench/README.md).
const runtimeGlobals = globalThis as typeof globalThis & {
  Bun?: { version: string; gc: (sync?: boolean) => void };
  Deno?: { version: { deno: string } };
};
const runtime = runtimeGlobals.Bun
  ? `bun ${runtimeGlobals.Bun.version}`
  : runtimeGlobals.Deno
  ? `deno ${runtimeGlobals.Deno.version.deno}`
  : `node ${process.versions.node}`;
const workload = process.env.WORKLOAD ?? "sample";
const readText = (text: string): number => {
  let sum = text.length;
  const step = workload === "scan"
    ? 1
    : Math.max(1, Math.floor(text.length / 64));
  for (let i = 0; i < text.length; i += step) {
    sum = (sum + text.charCodeAt(i)) >>> 0;
  }
  return sum;
};
export const plainText = task<string, number>({ f: readText });
export const sharedText = task<SharedArrayBuffer, number>({
  f: (bytes) => readText(bufferToString(bytes)),
});
export const movedText = task<BufferReference, number>({
  f: (ref) => readText(bufferToString(ref.toUint8Array())),
});
export const externalText = task<bigint, number>({
  f: (token) => readText(nativeStrings.adopt(token)),
});
export const copiedNativeText = task<bigint, number>({
  f: (token) => readText(nativeStrings.copy(token)),
});
export const collectNativeText = task<void, number>({
  f: async () => {
    runtimeGlobals.Bun?.gc(true);
    // Bun's Node-API string destructor queues the addon finalizer. Knitting's
    // synchronous dispatch loop must yield to run that native finalizer queue.
    if (runtimeGlobals.Bun) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      runtimeGlobals.Bun.gc(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return nativeStrings.stats().liveBytes;
  },
});

if (isMain) {
  const rounds = Number(process.env.ROUNDS ?? 100);
  const warmup = Number(process.env.WARMUP ?? 30);
  const sizeUnit = process.env.SIZE_UNIT ?? "bytes";
  const sizes = (process.env.SIZES ?? "1024,65536,1048576").split(",").map(
    Number,
  );
  const kinds = (process.env.KINDS ?? "ascii,latin1,utf16,emoji").split(",");
  const patterns: Record<string, string> = {
    ascii: "Knitting text 0123456789\n",
    latin1: "café déjà vu £ÿ\n",
    utf16: "編み物 Ελληνικά\n",
    emoji: "🧶🪡🙂🚀",
  };
  if (
    !Number.isSafeInteger(rounds) || rounds < 1 ||
    !Number.isSafeInteger(warmup) || warmup < 0 ||
    sizes.some((n) =>
      !Number.isSafeInteger(n) || n < 64 || n > 8 * 1024 * 1024
    ) ||
    kinds.some((kind) => !patterns[kind]) ||
    !["sample", "scan"].includes(workload) ||
    !["bytes", "codeUnits"].includes(sizeUnit)
  ) {
    throw new Error(
      "Invalid configuration; sizes are bytes/codeUnits, 64..8388608.",
    );
  }
  const pool = createPool({
    threads: 1,
    permission: {
      ...(runtimeGlobals.Deno || runtimeGlobals.Bun ? { ffi: true } : {}),
      node: { allowAddons: true },
    },
    payload: { payloadMaxByteLength: 256 * 1024 * 1024 },
  })({
    plainText,
    sharedText,
    movedText,
    externalText,
    copiedNativeText,
    collectNativeText,
  });
  const rows: Array<Record<string, string | number>> = [];
  const encoder = new TextEncoder();
  try {
    for (const kind of kinds) {
      for (const size of sizes) {
        const pattern = patterns[kind]!;
        const patternBytes = Buffer.byteLength(pattern);
        let text = sizeUnit === "bytes"
          ? pattern.repeat(Math.floor(size / patternBytes)) +
            "x".repeat(size % patternBytes)
          : pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size);
        // Do not split a surrogate pair: UTF-8 arms must receive equivalent text.
        if (
          text.charCodeAt(text.length - 1) >= 0xd800 &&
          text.charCodeAt(text.length - 1) <= 0xdbff
        ) {
          text = text.slice(0, -1) + "x";
        }
        const expected = readText(text);
        const utf8Bytes = Buffer.byteLength(text);
        const shared = stringToBuffer(text);
        const token = nativeStrings.retain(text);
        const allVariants: Array<[string, () => Promise<number>]> = [
          ["plain-string", () => pool.call.plainText(text)],
          [
            "native-transparent",
            () => callNativeString(pool.call.plainText, text),
          ],
          ["native-auto-64k", () => callAutoString(pool.call.plainText, text)],
          [
            "sab-fresh-decode",
            () => pool.call.sharedText(stringToBuffer(text)),
          ],
          ["sab-reuse-decode", () => pool.call.sharedText(shared)],
          ["moved-utf8-decode", async () => {
            const ref = new BufferReference(encoder.encode(text));
            try {
              return await pool.call.movedText(ref);
            } finally {
              ref.release();
            }
          }],
          ["native-fresh-external", async () => {
            const fresh = nativeStrings.retain(text);
            try {
              return await pool.call.externalText(fresh);
            } finally {
              nativeStrings.release(fresh);
            }
          }],
          ["native-reuse-external", () => pool.call.externalText(token)],
          ["native-fresh-copy", async () => {
            const fresh = nativeStrings.retain(text);
            try {
              return await pool.call.copiedNativeText(fresh);
            } finally {
              nativeStrings.release(fresh);
            }
          }],
          ["native-reuse-copy", () => pool.call.copiedNativeText(token)],
        ];
        const selected = (process.env.VARIANTS ??
          "plain-string,native-transparent,native-auto-64k,native-fresh-external,native-reuse-external,native-fresh-copy,native-reuse-copy")
          .split(",");
        if (
          selected.some((name) =>
            !allVariants.some(([variant]) => variant === name)
          )
        ) {
          throw new Error("Unknown VARIANTS entry");
        }
        const variants = allVariants.filter(([name]) =>
          selected.includes(name)
        );
        const samples = variants.map(() => [] as number[]);
        const adoptionCounts = variants.map(() => ({ external: 0, copied: 0 }));
        try {
          for (let round = -warmup; round < rounds; round++) {
            for (let offset = 0; offset < variants.length; offset++) {
              const index = (round + warmup + offset) % variants.length;
              const [name, run] = variants[index]!;
              const before = nativeStrings.stats();
              const start = performance.now();
              const actual = await run();
              const elapsedUs = (performance.now() - start) * 1000;
              if (actual !== expected) {
                throw new Error(`${kind}/${size}/${name}: content mismatch`);
              }
              if (round >= 0) {
                samples[index]!.push(elapsedUs);
                const after = nativeStrings.stats();
                adoptionCounts[index]!.external +=
                  (after.externalAdoptions ?? 0) -
                  (before.externalAdoptions ?? 0);
                adoptionCounts[index]!.copied += (after.copiedAdoptions ?? 0) -
                  (before.copiedAdoptions ?? 0);
              }
            }
          }
          variants.forEach(([variant], index) => {
            const sorted = samples[index]!.sort((a, b) => a - b);
            const at = (p: number) =>
              sorted[
                Math.min(sorted.length - 1, Math.floor(sorted.length * p))
              ]!;
            rows.push({
              kind,
              size,
              sizeUnit,
              codeUnits: text.length,
              utf8Bytes,
              variant,
              externalAdoptions: adoptionCounts[index]!.external,
              copiedAdoptions: adoptionCounts[index]!.copied,
              p10_us: at(0.1),
              p50_us: at(0.5),
              p90_us: at(0.9),
            });
          });
        } finally {
          nativeStrings.release(token);
        }
        // Bound native storage between fixture sizes on Bun; its worker heap
        // must collect before shutdown to run external-string finalizers.
        if (runtimeGlobals.Bun) {
          for (let i = 0; i < 10; i++) {
            if (await pool.call.collectNativeText(undefined) === 0) break;
          }
        }
      }
    }
    if (runtimeGlobals.Bun) {
      for (let i = 0; i < 10; i++) {
        if (await pool.call.collectNativeText(undefined) === 0) break;
      }
    }
  } finally {
    await pool.shutdown();
  }
  if (nativeStrings.stats().entries !== 0) {
    throw new Error("Leaked sender registry entries");
  }
  // External resources can survive until a later GC (including shared strings).
  // This optional reclamation check happens after every timed call.
  // Knitting captures and removes the exposed global GC during module setup.
  // A separate VM context retains it when Node was started with --expose-gc.
  const gc = (runtimeGlobals.Bun
    ? () =>
      runtimeGlobals.Bun!.gc(true)
    : runInNewContext("typeof gc === 'function' ? gc : undefined")) as
      | (() => void)
      | undefined;
  if (gc) {
    for (let i = 0; i < 20 && nativeStrings.stats().liveBytes > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
    }
    if (nativeStrings.stats().liveBytes !== 0) {
      throw new Error(
        `Unreclaimed native character storage: ${
          JSON.stringify(nativeStrings.stats())
        }`,
      );
    }
  }
  const result = {
    benchmark: "large-strings",
    runtime,
    backend: stringBackend,
    sizeUnit,
    rounds,
    warmup,
    workload,
    threads: 1,
    inflight: 1,
    metric:
      "call wall latency including fresh preparation and explicit release; excludes host validation",
    reuse:
      "shared/native reused preparation excluded; ordinary string input also reused",
    postRunGc: Boolean(gc),
    nativeLifetime: nativeStrings.stats(),
    rows,
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.table(
      rows.map((row) => ({
        ...row,
        p10_us: Number(Number(row.p10_us).toFixed(1)),
        p50_us: Number(Number(row.p50_us).toFixed(1)),
        p90_us: Number(Number(row.p90_us).toFixed(1)),
      })),
    );
  }
}
