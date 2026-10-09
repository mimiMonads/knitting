import { Buffer } from "node:buffer";
import { createPool, isMain, task } from "../../knitting.ts";
import { StringReference } from "../../experimental.ts";
import { getNativeStrings } from "../../src/connections/string-reference-native.ts";
import assert from "node:assert/strict";
import process from "node:process";
import { runInNewContext } from "node:vm";

const globals = globalThis as typeof globalThis & {
  Bun?: { version: string; gc(sync?: boolean): void };
  Deno?: { version: { deno: string } };
};
export const echoString = task<string, string>({ f: (text) => text });
export const echoReference = task<StringReference, StringReference>({
  f: (reference) => {
    try {
      // Materialize in the worker too: this exercises both directions' adoption.
      assert.equal(reference.toString().length, reference.length);
      return reference.clone();
    } finally {
      reference.release();
    }
  },
});
export const rebuildReference = task<StringReference, StringReference>({
  f: (reference) => {
    try {
      return new StringReference(reference.toString());
    } finally {
      reference.release();
    }
  },
});
export const failReference = task<StringReference, void>({
  f: (reference) => {
    reference.release();
    throw new Error("expected reference failure");
  },
});
export const collectReferences = task<void, number>({
  f: async () => {
    if (globals.Bun) globals.Bun.gc(true);
    else runInNewContext("typeof gc === 'function' ? gc() : undefined");
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (globals.Bun) globals.Bun.gc(true);
    else runInNewContext("typeof gc === 'function' ? gc() : undefined");
    await new Promise((resolve) => setTimeout(resolve, 0));
    return getNativeStrings().stats().entries;
  },
});

const patterns = {
  ascii: "Knitting text 0123456789\n",
  latin1: "café déjà vu £ÿ\n",
  utf16: "編み物 Ελληνικά\n",
  emoji: "🧶🪡🙂🚀",
};
async function runRoundTrips() {
  const rounds = Number(process.env.ROUNDS ?? 200);
  const warmup = Number(process.env.WARMUP ?? 60);
  const modes = (process.env.MODES ?? "plain,shared,rebuilt").split(",");
  const kinds = (process.env.KINDS ?? Object.keys(patterns).join(",")).split(",");
  if (modes.some((mode) => !["plain", "shared", "rebuilt", "reused"].includes(mode)) ||
      kinds.some((kind) => !Object.hasOwn(patterns, kind))) {
    throw new Error("Unknown MODES or KINDS selection");
  }
  if (
    !Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(warmup) ||
    warmup < 0
  ) {
    throw new Error("ROUNDS must be positive and WARMUP nonnegative integers");
  }
  const runtime = globals.Bun
    ? `bun ${globals.Bun.version}`
    : globals.Deno
    ? `deno ${globals.Deno.version.deno}`
    : `node ${process.versions.node}`;
  const pool = createPool({
    threads: 1,
    permission: {
      node: { allowAddons: true },
      ...(globals.Bun || globals.Deno ? { ffi: true } : {}),
    },
  })({
    echoString,
    echoReference,
    rebuildReference,
    failReference,
    collectReferences,
  });
  const rows: unknown[] = [];
  let survivor: StringReference | undefined;
  try {
    for (const text of ["", "\0\ud800x\udfff", "é編🧶".repeat(8192)]) {
      const source = new StringReference(text);
      const clone = source.clone();
      source.release();
      assert.equal(clone.toString(), text);
      const output = await pool.call.echoReference(clone);
      clone.release();
      assert.equal(output.toString(), text);
      output.release();
      assert.throws(() => output.toString(), /released/);
    }
    const bad = new StringReference("failure");
    await assert.rejects(
      pool.call.failReference(bad),
      /expected reference failure/,
    );
    bad.release();
    const queued = await Promise.all(
      Array.from({ length: 24 }, async (_, i) => {
        const text = `${i}:\0é編🧶\ud800`.repeat(1024);
        const source = new StringReference(text);
        try {
          const output = await pool.call.echoReference(source);
          try {
            assert.equal(output.toString(), text);
          } finally {
            output.release();
          }
        } finally {
          source.release();
        }
      }),
    );
    assert.equal(queued.length, 24);
    for (const bytes of [1024, 65536, 1048576]) {
      for (const [kind, pattern] of Object.entries(patterns)) {
        if (!kinds.includes(kind)) continue;
        const count = Math.floor(bytes / Buffer.byteLength(pattern));
        const prefix = pattern.repeat(count);
        const text = prefix + "x".repeat(bytes - Buffer.byteLength(prefix));
        assert.equal(Buffer.byteLength(text), bytes);
        // Reuse deliberately excludes initial construction from call latency.
        const reusable = modes.includes("reused") ? new StringReference(text) : undefined;
        try {
          for (const mode of modes) {
            const times: number[] = [];
            for (let i = -warmup; i < rounds; i++) {
              const start = performance.now();
              let returned: string;
              if (mode === "plain") returned = await pool.call.echoString(text);
              else {
                const source = mode === "reused" ? reusable! : new StringReference(text);
                try {
                  const output = await (mode === "shared" || mode === "reused"
                    ? pool.call.echoReference(source)
                    : pool.call.rebuildReference(source));
                  try {
                    returned = output.toString();
                  } finally {
                    output.release();
                  }
                } finally {
                  if (mode !== "reused") source.release();
                }
              }
              const elapsed = (performance.now() - start) * 1000;
              // Full equality outside the timing: validates all code units in both directions.
              assert.equal(returned, text);
              if (i >= 0) times.push(elapsed);
            }
            times.sort((a, b) => a - b);
            rows.push({
              bytes,
              kind,
              mode,
              p50_us: times[Math.floor(times.length / 2)],
              p90_us: times[Math.floor(times.length * .9)],
            });
            await pool.call.collectReferences(undefined);
          }
        } finally {
          reusable?.release();
        }
      }
    }
    const source = new StringReference(
      "survives worker shutdown: \0é編🧶\ud800".repeat(1024),
    );
    survivor = await pool.call.echoReference(source);
    source.release();
    await pool.call.collectReferences(undefined);
  } finally {
    await pool.shutdown();
  }
  assert.equal(
    survivor!.toString(),
    "survives worker shutdown: \0é編🧶\ud800".repeat(1024),
  );
  survivor!.release();
  return { runtime, rounds, warmup, rows };
}
if (isMain) {
  const results = await runRoundTrips();
  for (let i = 0; i < 6; i++) {
    if (globals.Bun) globals.Bun.gc(true);
    else runInNewContext("typeof gc === 'function' ? gc() : undefined");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const stats = getNativeStrings().stats();
  assert.equal(stats.entries, 0);
  assert.equal(stats.liveBytes, 0);
  console.log(
    JSON.stringify({
      ...results,
      stats,
      checks:
        "exact strings, empty, NUL, lone surrogates, clone after release, concurrent calls, task error, reference after worker shutdown",
    }),
  );
}
