import { createPool, isMain, task } from "../../knitting.ts";
import { callAutoString, callNativeString } from "./string-transport.ts";
import { nativeStrings } from "./string-reference.mjs";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

const runtime = globalThis as typeof globalThis & {
  Bun?: { gc: (sync?: boolean) => void };
  Deno?: unknown;
};
const hash = (text: string): number => {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value = Math.imul(value ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return value;
};
let held = "";
export const takeText = task<string, number>({
  f: (text) => {
    if (typeof text !== "string") {
      throw new TypeError("Worker must receive a primitive string");
    }
    return hash(text);
  },
});
export const holdText = task<string, number>({
  f: (text) => {
    held = text;
    return hash(text);
  },
});
export const readHeld = task<void, number>({ f: () => hash(held) });
export const failText = task<string, number>({
  f: () => {
    throw new Error("expected task failure");
  },
});
export const collectText = task<void, number>({
  f: async () => {
    if (runtime.Bun) runtime.Bun.gc(true);
    else runInNewContext("typeof gc === 'function' ? gc() : undefined");
    if (runtime.Bun) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      runtime.Bun.gc(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return nativeStrings.stats().liveBytes;
  },
});

if (isMain) {
  const pool = createPool({
    threads: 1,
    permission: {
      ...(runtime.Deno || runtime.Bun ? { ffi: true } : {}),
      node: { allowAddons: true },
    },
  })({ takeText, holdText, readHeld, failText, collectText });
  try {
    for (const text of ["", "a", "café", "編🧶\0\ud800x\udfff".repeat(8192)]) {
      assert.equal(
        await callNativeString(pool.call.takeText, text),
        hash(text),
      );
    }
    const retained = "編🧶\ud800\0".repeat(8192);
    await callNativeString(pool.call.holdText, retained);
    assert.equal(nativeStrings.stats().entries, 0);
    await pool.call.collectText(undefined);
    assert.equal(await pool.call.readHeld(undefined), hash(retained));
    const queued = Array.from(
      { length: 32 },
      (_, i) => `call:${i}\0é🧶`.repeat(1024),
    );
    const actual = await Promise.all(
      queued.map((text) => callNativeString(pool.call.takeText, text)),
    );
    assert.deepEqual(actual, queued.map(hash));
    await assert.rejects(
      callNativeString(pool.call.failText, "error".repeat(8192)),
    );
    await assert.rejects(callNativeString(() => {
      throw new Error("send failed");
    }, "value"));
    assert.equal(
      await callAutoString(pool.call.takeText, "small"),
      hash("small"),
    );
    assert.equal(
      await callAutoString(pool.call.takeText, "large".repeat(16384)),
      hash("large".repeat(16384)),
    );
    assert.equal(nativeStrings.stats().entries, 0);
    await pool.call.holdText("");
    for (let i = 0; i < 10; i++) {
      if (await pool.call.collectText(undefined) === 0) break;
    }
  } finally {
    await pool.shutdown();
  }
  const gc = runtime.Bun
    ? () => runtime.Bun!.gc(true)
    : runInNewContext("typeof gc === 'function' ? gc : undefined");
  if (typeof gc !== "function") {
    throw new Error("Run Node/Deno with exposed GC");
  }
  for (let i = 0; i < 20 && nativeStrings.stats().liveBytes > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
  assert.equal(nativeStrings.stats().entries, 0);
  assert.equal(nativeStrings.stats().liveBytes, 0);
  console.log(
    "Ordinary-string transport: exact code units, retained strings, queued calls, errors, policy fallback and GC passed.",
  );
}
