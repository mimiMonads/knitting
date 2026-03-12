import assert from "node:assert/strict";
import test from "node:test";
import { createPool, task } from "../knitting.ts";

const addOne = task<number, number>({
  f: async (value) => value + 1,
});
const TEST_FILE_URL = new URL(import.meta.url).href;
const denoVersion = (
  globalThis as typeof globalThis & {
    Deno?: { version?: { deno?: string } };
  }
).Deno?.version?.deno;

test("deno surfaces worker URL diagnostics for unsupported worker entry URLs", () => {
  if (typeof denoVersion !== "string") {
    return;
  }

  let thrown: unknown;
  try {
    createPool({
      threads: 1,
      source: "https://example.com/worker-entry.ts",
    })({ addOne });
  } catch (error) {
    thrown = error;
  }

  assert.equal(thrown instanceof TypeError, true);
  const text = String(thrown);
  assert.match(text, /KNT_ERROR_DENO_WORKER_UNSUPPORTED_URL/);
  assert.match(text, /https:\/\/example\.com\/worker-entry\.ts/);
  assert.match(text, /Task modules discovered from caller resolution:/);
  assert.match(
    text,
    new RegExp(TEST_FILE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});
