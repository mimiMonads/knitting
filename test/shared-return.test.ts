import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { SHARED_RETURN_BORROW_WINDOW } from "../src/memory/payloadCodec.ts";
import {
  plainStamped,
  sharedPartialWrite,
  sharedPrefix,
  sharedStamped,
} from "./fixtures/shared_return_tasks.ts";

const supported = typeof SharedArrayBuffer === "function";

// Over SHARED_RETURN_MIN_BYTES, so an ordinary return is handed over borrowed.
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

test("an ordinary large return survives its borrow window", async () => {
  if (!supported) return;
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytes: true },
  })({ plainStamped });
  try {
    const held = await pool.call.plainStamped(pack(3, BIG));
    assert.equal(held[0], 3);

    // Well inside the window: the region backing `held` must not be reused yet.
    for (let i = 0; i < SHARED_RETURN_BORROW_WINDOW - 2; i++) {
      const next = await pool.call.plainStamped(pack(9, BIG));
      assert.equal(next[0], 9);
    }
    assert.equal(held[0], 3, "a view must stay readable inside its window");
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
