import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { getBufferReferenceCapabilities } from "../src/connections/buffer-reference-native.ts";
import { SHARED_RETURN_BORROW_WINDOW } from "../src/memory/payloadCodec.ts";
import {
  keptArrayBufferByteLength,
  keptReturnByteLength,
  plainStamped,
  returnAndKeepArrayBuffer,
  returnAndKeepBytes,
  returnScratchPrefix,
  returnWasmBytes,
  scratchByteLength,
  sharedPartialWrite,
  sharedPrefix,
  sharedStamped,
  stampWasmByte,
} from "./fixtures/shared_return_tasks.ts";

const supported = typeof SharedArrayBuffer === "function";
const supportsAutomaticMove = (): boolean => {
  try {
    getBufferReferenceCapabilities();
    return true;
  } catch {
    return false;
  }
};

// At the automatic ownership-move threshold.
const BIG = 256 * 1024;
// Under it, so ordinary returns of this size must stay copies.
const SMALL = 1024;

const pack = (stamp: number, bytes: number): number => (stamp << 21) | bytes;

test("sharedBytes returns arrive intact when enabled", async () => {
  if (!supported) return;
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytes: true },
  })({ sharedStamped });
  try {
    for (let stamp = 1; stamp <= 8; stamp++) {
      const out = await pool.call.sharedStamped(pack(stamp, BIG));
      assert.equal(out.byteLength, BIG);
      assert.equal(out[0], stamp);
      assert.equal(out[BIG - 1], stamp);
    }
  } finally {
    await pool.shutdown();
  }
});

test("sharedBytes(n, true) zeroes the region it hands out", async () => {
  if (!supported) return;
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytes: true },
  })({
    sharedStamped,
    sharedPartialWrite,
  });
  try {
    // Fill a region with 0xff, then take one back and write only its first byte.
    for (let i = 0; i < 4; i++) {
      await pool.call.sharedStamped(pack(0xff, BIG));
    }
    for (let i = 0; i < 4; i++) {
      const out = await pool.call.sharedPartialWrite(pack(7, BIG));
      assert.equal(out[0], 7);
      assert.equal(out[1], 0, "unwritten bytes must be zero, not 0xff");
      assert.equal(out[BIG - 1], 0);
    }
  } finally {
    await pool.shutdown();
  }
});

test("an ordinary large return stays owned when sharedBytes is enabled", async () => {
  if (!supported) return;
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytes: true },
  })({ plainStamped });
  try {
    const held = await pool.call.plainStamped(pack(3, BIG));
    assert.equal(held[0], 3);
    assert.ok(
      !(held.buffer instanceof SharedArrayBuffer),
      "only an explicit sharedBytes() allocation may be borrowed",
    );

    for (let i = 0; i < SHARED_RETURN_BORROW_WINDOW * 3; i++) {
      const next = await pool.call.plainStamped(pack(9, BIG));
      assert.equal(next[0], 9);
    }
    assert.equal(held[0], 3, "ordinary results are not part of the borrow window");
    assert.equal(held[BIG - 1], 3);
  } finally {
    await pool.shutdown();
  }
});

test("a prefix of a borrowed region is returned without a copy", async () => {
  if (!supported) return;
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytes: true },
  })({ sharedPrefix });
  try {
    for (let stamp = 1; stamp <= 6; stamp++) {
      // Deliberately under SHARED_RETURN_MIN_BYTES: if the encoder did not
      // recognise the subarray as still borrowed, this size would fall back to
      // the copy path and arrive on a private ArrayBuffer instead.
      const out = await pool.call.sharedPrefix(pack(stamp, SMALL));
      assert.equal(out.byteLength, SMALL, "only the written prefix is sent");
      assert.equal(out[0], stamp);
      assert.equal(out[SMALL - 1], stamp);
      assert.ok(
        out.buffer instanceof SharedArrayBuffer,
        "a borrowed prefix must still alias the payload arena",
      );
    }
  } finally {
    await pool.shutdown();
  }
});

test("small returns are copies and outlive any window", async () => {
  if (!supported) return;
  const pool = createPool({ threads: 1 })({ plainStamped });
  try {
    const held = await pool.call.plainStamped(pack(5, SMALL));
    for (let i = 0; i < SHARED_RETURN_BORROW_WINDOW * 3; i++) {
      await pool.call.plainStamped(pack(1, SMALL));
    }
    assert.equal(held[0], 5, "a copied return is owned by its receiver");
    assert.equal(held[SMALL - 1], 5);
  } finally {
    await pool.shutdown();
  }
});

test("shared-byte returns are disabled by default", async () => {
  if (!supported) return;
  const pool = createPool({ threads: 1 })({ plainStamped, sharedStamped });
  try {
    const plain = await pool.call.plainStamped(pack(4, BIG));
    const shared = await pool.call.sharedStamped(pack(6, BIG));
    assert.ok(!(plain.buffer instanceof SharedArrayBuffer));
    assert.ok(!(shared.buffer instanceof SharedArrayBuffer));
    assert.equal(plain[BIG - 1], 4);
    assert.equal(shared[BIG - 1], 6);
  } finally {
    await pool.shutdown();
  }
});

test("a large thread return is moved to an owned host buffer by default", async () => {
  if (!supported || !supportsAutomaticMove()) return;
  const pool = createPool({ threads: 1 })({
    returnAndKeepBytes,
    keptReturnByteLength,
  });
  let out: Uint8Array | undefined;
  try {
    out = await pool.call.returnAndKeepBytes(pack(7, BIG));
    assert.equal(out[0], 7);
    assert.equal(out[BIG - 1], 7);
    assert.equal(
      await pool.call.keptReturnByteLength(),
      0,
      "the worker-side result was moved, not retained as a borrowed view",
    );
  } finally {
    await pool.shutdown();
  }
  assert.equal(out?.[0], 7, "the host owns the returned bytes after shutdown");
  assert.equal(out?.[BIG - 1], 7);
});

test("a large thread ArrayBuffer return is moved by default", async () => {
  if (!supported || !supportsAutomaticMove()) return;
  const pool = createPool({ threads: 1 })({
    returnAndKeepArrayBuffer,
    keptArrayBufferByteLength,
  });
  let out: ArrayBuffer | undefined;
  try {
    out = await pool.call.returnAndKeepArrayBuffer(pack(6, BIG));
    const view = new Uint8Array(out);
    assert.equal(view[0], 6);
    assert.equal(view[BIG - 1], 6);
    assert.equal(await pool.call.keptArrayBufferByteLength(), 0);
  } finally {
    await pool.shutdown();
  }
  assert.equal(new Uint8Array(out!)[0], 6);
});

test("unsafe.SharedBytes: false keeps every return a private copy", async () => {
  if (!supported) return;
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytes: false },
  })({ plainStamped, sharedStamped });
  try {
    const held = await pool.call.plainStamped(pack(4, BIG));
    // Far past any borrow window; with borrowing off nothing may disturb it.
    for (let i = 0; i < SHARED_RETURN_BORROW_WINDOW * 3; i++) {
      await pool.call.plainStamped(pack(8, BIG));
    }
    assert.equal(held[0], 4);
    assert.equal(held[BIG - 1], 4);

    // `sharedBytes` degrades to a plain allocation rather than failing.
    const shared = await pool.call.sharedStamped(pack(6, BIG));
    assert.equal(shared.byteLength, BIG);
    assert.equal(shared[BIG - 1], 6);
  } finally {
    await pool.shutdown();
  }
});

test("returning a slice of a reused buffer does not detach the buffer", async () => {
  if (!supported) return;
  const pool = createPool({ threads: 1 })({
    returnScratchPrefix,
    scratchByteLength,
  });
  try {
    const first = await pool.call.returnScratchPrefix(pack(7, BIG));
    assert.equal(first.byteLength, BIG);
    assert.equal(first[0], 7);
    assert.equal(first[BIG - 1], 7);

    // A move would have taken the whole 1 MiB scratch, not the returned slice.
    assert.equal(
      await pool.call.scratchByteLength(),
      1024 * 1024,
      "the worker's scratch buffer survived the return",
    );

    // Which is only observable on the next call: it reuses that scratch.
    const second = await pool.call.returnScratchPrefix(pack(9, BIG));
    assert.equal(second[0], 9);
    assert.equal(second[BIG - 1], 9);
  } finally {
    await pool.shutdown();
  }
});

test("a source that cannot be detached is copied, not aliased", async () => {
  if (!supported) return;
  const pool = createPool({ threads: 1 })({ returnWasmBytes, stampWasmByte });
  const WASM_BYTES = 4 * 65536;
  try {
    const out = await pool.call.returnWasmBytes(pack(3, 0));
    assert.equal(out.byteLength, WASM_BYTES);
    assert.equal(out[0], 3);
    assert.equal(out[WASM_BYTES - 1], 3);

    // The worker's memory must still be there: a failed move must fall back
    // to copying rather than half-moving it.
    assert.equal(
      await pool.call.stampWasmByte(42),
      42,
      "the worker's wasm memory is intact and writable",
    );

    // And the host's result must not have followed that write. When the move
    // silently kept a store aliasing live wasm memory, this read 42.
    assert.equal(out[0], 3, "the host's result is a copy, not an alias");
  } finally {
    await pool.shutdown();
  }
});
