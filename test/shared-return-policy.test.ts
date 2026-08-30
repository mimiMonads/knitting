import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { sharedReturnsEnabled } from "./_shared-return-enabled.ts";
import {
  plainSmall,
  plainStamped,
  sharedPartialWrite,
  sharedPoolStats,
  sharedStamped,
} from "./fixtures/shared_return_tasks.ts";

const supported = typeof SharedArrayBuffer === "function";

// Over SAB_SLAB_MIN_BYTES, so returns qualify for a slab.
const BIG = 64 * 1024;
// Under it, so returns must stay on the copy path.
const SMALL = 1024;

const pack = (stamp: number, bytes: number): number => (stamp << 21) | bytes;

type PoolStats = { slabs: number; idle: number; bytes: number; reclaim: string };

// Which path a return took is not reliably visible from the result's shape --
// a copied return is also a view into a bigger arena buffer -- so ask the
// worker's pool directly. A slab only ever exists because something was
// admitted to the pointer path.
const statsOf = async (
  call: { sharedPoolStats: () => Promise<string> },
): Promise<PoolStats> => JSON.parse(await call.sharedPoolStats()) as PoolStats;

test("an ordinary Uint8Array return is upgraded into a slab", async () => {
  if (!sharedReturnsEnabled) return;

  // Lowered so the test does not have to move a megabyte per call; the default
  // threshold itself is pinned by the test below.
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytesUpgradeMinBytes: BIG },
  })({ plainStamped, plainSmall, sharedPoolStats });
  try {
    // Under the threshold nothing may be upgraded, so the copy path stays
    // reachable and this is not silently a slab-only transport.
    for (let i = 0; i < 4; i++) {
      const small = await pool.call.plainSmall(pack(9, SMALL));
      assert.equal(small.byteLength, SMALL);
      assert.equal(small[SMALL - 1], 9);
    }
    assert.equal(
      (await statsOf(pool.call)).slabs,
      0,
      "a return under the slab threshold must still be copied",
    );

    const big = await pool.call.plainStamped(pack(7, BIG));
    assert.equal(big.byteLength, BIG);
    for (let at = 0; at < BIG; at += 4096) assert.equal(big[at], 7);
    assert.equal(big[BIG - 1], 7, "last byte of an upgraded return");
    assert.ok(
      (await statsOf(pool.call)).slabs > 0,
      "a plain Uint8Array over the threshold must be upgraded into a slab",
    );
  } finally {
    await pool.shutdown();
  }
});

test("the default upgrade threshold is above the sharedBytes threshold", async () => {
  if (!sharedReturnsEnabled) return;

  // `sharedBytes` builds in the slab and copies nothing; upgrading an ordinary
  // array adds a worker-side memcpy, so it needs a higher bar. At 64 KiB the
  // upgrade measured as a regression on node, so a plain return that size must
  // still be copied even though a `sharedBytes` return that size would not be.
  const pool = createPool({ threads: 1 })({
    plainStamped,
    sharedStamped,
    sharedPoolStats,
  });
  try {
    await pool.call.plainStamped(pack(4, BIG));
    assert.equal(
      (await statsOf(pool.call)).slabs,
      0,
      "a 64KiB plain return must not be upgraded at the default threshold",
    );

    const direct = await pool.call.sharedStamped(pack(4, BIG));
    assert.equal(direct[BIG - 1], 4);
    assert.ok(
      (await statsOf(pool.call)).slabs > 0,
      "the same size via sharedBytes must still take a slab",
    );
  } finally {
    await pool.shutdown();
  }
});

test("upgraded returns keep their own bytes under concurrency", async () => {
  if (!supported) return;

  const pool = createPool({
    threads: 2,
    unsafe: { SharedBytesUpgradeMinBytes: BIG },
  })({ plainStamped });
  const INFLIGHT = 16;
  try {
    for (let round = 0; round < 20; round++) {
      const stamps = Array.from(
        { length: INFLIGHT },
        (_, j) => ((round * INFLIGHT + j) % 250) + 1,
      );
      const outs = await Promise.all(
        stamps.map((stamp) => pool.call.plainStamped(pack(stamp, BIG))),
      );
      for (let j = 0; j < INFLIGHT; j++) {
        const out = outs[j]!;
        assert.equal(out.byteLength, BIG);
        for (let at = 0; at < BIG; at += 4096) {
          assert.equal(
            out[at],
            stamps[j],
            `byte ${at} of call ${j} in round ${round} belongs to another call`,
          );
        }
      }
    }
  } finally {
    await pool.shutdown();
  }
});

test("a partially written slab returns zeros, not the previous return", async () => {
  if (!supported) return;

  // A ring of 4 is the point of this test: at the default depth of 64 the ring
  // still has fresh, already-zero slabs to hand out and no reuse ever happens,
  // so the zero-fill is never actually exercised.
  const RING = 4;
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytesRingSlabs: RING },
  })({ sharedStamped, sharedPartialWrite });
  try {
    // Dirty every slab in the ring with a recognisable pattern, then let the
    // ring hand those same slabs out to a task that writes only one byte.
    // Without the zero-fill the tail is whatever 0xAB left behind.
    for (let i = 0; i < RING * 2; i++) {
      const dirty = await pool.call.sharedStamped(pack(0xab, BIG));
      assert.equal(dirty[BIG - 1], 0xab, "setup must actually fill the slab");
    }
    for (let i = 0; i < RING * 2; i++) {
      const out = await pool.call.sharedPartialWrite(pack(0x11, BIG));
      assert.equal(out.byteLength, BIG);
      assert.equal(out[0], 0x11, "the byte the task actually wrote");
      for (let at = 1; at < BIG; at += 997) {
        assert.equal(
          out[at],
          0,
          `byte ${at} leaked a previous return (round ${i})`,
        );
      }
      assert.equal(out[BIG - 1], 0, "last byte leaked a previous return");
    }
  } finally {
    await pool.shutdown();
  }
});

test("unsafe.SharedBytes false takes the pointer path out entirely", async () => {
  if (!supported) return;

  const pool = createPool({ threads: 1, unsafe: { SharedBytes: false } })({
    sharedStamped,
    plainStamped,
    sharedPoolStats,
  });
  try {
    assert.equal(
      (await statsOf(pool.call)).reclaim,
      "off",
      "no slab pool should be installed in the worker",
    );

    // Both paths must still return correct bytes, just copied.
    const direct = await pool.call.sharedStamped(pack(5, BIG));
    assert.equal(direct.byteLength, BIG);
    assert.equal(direct[BIG - 1], 5);

    const upgraded = await pool.call.plainStamped(pack(6, BIG));
    assert.equal(upgraded.byteLength, BIG);
    assert.equal(upgraded[BIG - 1], 6);

    const stats = await statsOf(pool.call);
    assert.equal(stats.slabs, 0, "no slab may be minted while disabled");
    assert.equal(stats.bytes, 0, "no shared memory may be held while disabled");
  } finally {
    await pool.shutdown();
  }
});

test("slab views are detached when their worker goes away", async () => {
  if (!supported) return;

  const pool = createPool({ threads: 1 })({ sharedStamped, sharedPoolStats });
  const out = await pool.call.sharedStamped(pack(3, BIG));
  assert.equal(out[BIG - 1], 3, "readable while the worker is alive");
  const slabBacked = (await statsOf(pool.call)).slabs > 0;

  await pool.shutdown();

  if (!slabBacked) return; // copied return: nothing aliases the worker

  // The worker's memory is gone, so the alias must be detached. Detaching is
  // observable without reading: a view over a detached buffer reports zero
  // length. Read `out[BIG - 1]` only to confirm it no longer yields the live
  // value -- and never inside a try/catch that would let a failed assertion
  // masquerade as the throw we are looking for.
  assert.equal(
    out.buffer.byteLength,
    0,
    "the adopted slab alias must be detached once its worker is gone",
  );
  assert.equal(out.byteLength, 0, "a detached view must report zero length");
  assert.notEqual(
    out[BIG - 1],
    3,
    "a slab view must not still read its worker's bytes after teardown",
  );
});
