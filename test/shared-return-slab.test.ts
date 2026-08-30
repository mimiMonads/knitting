import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { sharedReturnsEnabled } from "./_shared-return-enabled.ts";
import {
  sharedPoolStats,
  sharedRingDepthProbe,
  sharedStamped,
} from "./fixtures/shared_return_tasks.ts";

const supported = typeof SharedArrayBuffer === "function";
const BYTES = 64 * 1024;
// Keep this focused slab-lifetime test shallow; dynamic payload admission is
// covered separately by dynamic-payload-inflight.test.ts.
const INFLIGHT = 16;

const stampFor = (round: number, j: number): number =>
  ((round * INFLIGHT + j) % 250) + 1;

test("slab returns carry their own bytes under concurrency", async () => {
  if (!supported) return;

  const pool = createPool({ threads: 2 })({ sharedStamped, sharedPoolStats });
  try {
    for (let round = 0; round < 30; round++) {
      const stamps = Array.from(
        { length: INFLIGHT },
        (_, j) => stampFor(round, j),
      );
      const outs = await Promise.all(
        stamps.map((stamp) => pool.call.sharedStamped((stamp << 21) | BYTES)),
      );
      for (let j = 0; j < INFLIGHT; j++) {
        const out = outs[j]!;
        assert.equal(out.byteLength, BYTES, "slab view must be cut to the payload");
        // A slab refilled while this view was still live would show another
        // call's stamp somewhere in the buffer.
        for (let at = 0; at < BYTES; at += 1024) {
          assert.equal(
            out[at],
            stamps[j],
            `byte ${at} of call ${j} in round ${round} belongs to another call`,
          );
        }
        assert.equal(out[BYTES - 1], stamps[j]);
      }
    }
  } finally {
    await pool.shutdown();
  }
});

test("slab returns stay inside the pool budget", async () => {
  if (!sharedReturnsEnabled) return;

  const pool = createPool({ threads: 1 })({ sharedStamped, sharedPoolStats });
  try {
    for (let round = 0; round < 20; round++) {
      await Promise.all(
        Array.from(
          { length: INFLIGHT },
          (_, j) => pool.call.sharedStamped((stampFor(round, j) << 21) | BYTES),
        ),
      );
    }
    const stats = JSON.parse(await pool.call.sharedPoolStats()) as {
      slabs: number;
      idle: number;
      bytes: number;
    };
    assert.ok(stats.slabs > 0, "the pool should have minted slabs");
    assert.ok(
      stats.bytes <= 64 * 1024 * 1024,
      `pool held ${stats.bytes} bytes, past its budget`,
    );
  } finally {
    await pool.shutdown();
  }
});

test("returns below the slab threshold still round-trip", async () => {
  if (!supported) return;

  // sharedBytes falls back to a plain Uint8Array under the threshold; the value
  // must survive the ordinary copy path unchanged.
  const pool = createPool({ threads: 1 })({ sharedStamped, sharedPoolStats });
  try {
    const out = await pool.call.sharedStamped((42 << 21) | 256);
    assert.equal(out.byteLength, 256);
    assert.equal(out[0], 42);
    assert.equal(out[255], 42);
  } finally {
    await pool.shutdown();
  }
});

test("a slab view is borrowed: holding it past the ring wrap aliases", async () => {
  if (!sharedReturnsEnabled) return;

  // Pins the contract rather than a bug. Ring reclamation refills a slab after
  // `ringSlabs` further returns on the lane, so a consumer that keeps a view
  // longer than that reads a later call's bytes. Kept small so the wrap is
  // quick and unambiguous.
  const RING = 4;
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytesReclaim: "ring", SharedBytesRingSlabs: RING },
  })({ sharedRingDepthProbe, sharedPoolStats });
  try {
    const held = await pool.call.sharedRingDepthProbe((1 << 21) | BYTES);
    assert.equal(held[0], 1, "the view is correct when it is handed over");

    for (let i = 2; i <= RING + 1; i++) {
      const fresh = await pool.call.sharedRingDepthProbe((i << 21) | BYTES);
      assert.equal(fresh[0], i, `call ${i} must see its own bytes`);
    }

    assert.notEqual(
      held[0],
      1,
      "the retained view should have been refilled once the ring wrapped; " +
        "if this ever holds, the borrow contract has become stronger than documented",
    );
  } finally {
    await pool.shutdown();
  }
});

test("gc reclamation keeps a retained view valid", async () => {
  if (!supported) return;

  // The same sequence under "gc": a slab is never refilled while the host can
  // still reach its view, so the retained buffer keeps its bytes.
  const RING = 4;
  const pool = createPool({
    threads: 1,
    unsafe: { SharedBytesReclaim: "gc" },
  })({ sharedRingDepthProbe, sharedPoolStats });
  try {
    const held = await pool.call.sharedRingDepthProbe((1 << 21) | BYTES);
    for (let i = 2; i <= RING + 1; i++) {
      await pool.call.sharedRingDepthProbe((i << 21) | BYTES);
    }
    assert.equal(held[0], 1, "a held view must survive under gc reclamation");
    assert.equal(held[BYTES - 1], 1);
  } finally {
    await pool.shutdown();
  }
});
