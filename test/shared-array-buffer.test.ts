import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import {
  sabEcho,
  sabIncrementFirst,
  sabIsShared,
  sabOwnStamped,
  sabSum,
  sabWorkerStamp,
} from "./fixtures/shared_array_buffer_tasks.ts";

const supported = typeof SharedArrayBuffer === "function";

const runtimeProcess = (globalThis as typeof globalThis & {
  process?: { versions?: { node?: string; bun?: string } };
  Deno?: unknown;
}).process;
const isNode = typeof runtimeProcess?.versions?.node === "string" &&
  runtimeProcess?.versions?.bun === undefined &&
  (globalThis as { Deno?: unknown }).Deno === undefined;

test("SharedArrayBuffer is transported by reference to a thread worker", async () => {
  if (!supported) return;

  const sab = new SharedArrayBuffer(16);
  new Int32Array(sab).set([1, 2, 3, 4]);

  const pool = createPool({ threads: 1 })({ sabSum });
  try {
    assert.equal(await pool.call.sabSum(sab), 10);
    assert.equal(sab.byteLength, 16);
  } finally {
    await pool.shutdown();
  }
});

test("worker writes through the shared buffer are visible on the host", async () => {
  if (!supported) return;

  const sab = new SharedArrayBuffer(16);
  new Int32Array(sab).set([5, 0, 0, 0]);

  const pool = createPool({ threads: 1 })({ sabIncrementFirst });
  try {
    const updated = await pool.call.sabIncrementFirst(sab);
    assert.equal(updated, 105, "worker sees and mutates the shared bytes");
    assert.equal(
      new Int32Array(sab)[0],
      105,
      "host observes the worker's write (shared by reference, not copied)",
    );
  } finally {
    await pool.shutdown();
  }
});

test("the worker borrows a pointer-alias over the shared bytes", async () => {
  if (!supported) return;

  const sab = new SharedArrayBuffer(8);
  const pool = createPool({ threads: 1 })({ sabIsShared });
  try {
    // Worker gets a pointer alias; direct SAB co-ownership can crash on teardown.
    const isShared = await pool.call.sabIsShared(sab);
    assert.equal(isShared, false);
    void isNode;
  } finally {
    await pool.shutdown();
  }
});

test("a returned shared buffer alias is still by reference", async () => {
  if (!supported) return;

  const sab = new SharedArrayBuffer(16);
  const hostView = new Int32Array(sab);
  hostView.set([10, 20, 30, 40]);

  const pool = createPool({ threads: 1 })({ sabEcho });
  try {
    const returned = await pool.call.sabEcho(sab);
    const returnedView = new Int32Array(returned);
    returnedView[1] += 7;

    assert.equal(
      hostView[1],
      27,
      "returned buffer should alias the host SAB, not copy it",
    );
  } finally {
    await pool.shutdown();
  }
});

test("each worker's returned SharedArrayBuffer survives token collisions", async () => {
  if (!supported) return;

  // Producer tokens come from a per-isolate counter that restarts at 1, so every
  // worker mints token 1 for its own buffer. A host cache keyed by token alone
  // hands the first worker's bytes back for every later worker's payload.
  const threads = 4;
  const calls = 200;
  const pool = createPool({ threads })({ sabWorkerStamp, sabOwnStamped });
  try {
    const sweepWorkers = async (seen: Set<number>): Promise<Set<number>> => {
      await Promise.all(
        Array.from({ length: calls }, async () => {
          seen.add(await pool.call.sabWorkerStamp());
        }),
      );
      return seen;
    };

    // The two sets only describe the same pool once every worker has booted: a
    // worker still starting up serves no call in the sweep that samples it, so
    // sampling each set once compares two different populations and disagrees
    // in whichever direction lost the race. Boot them all first.
    const stampsFromWorkers = new Set<number>();
    const bootDeadline = Date.now() + 10_000;
    while (stampsFromWorkers.size < threads && Date.now() < bootDeadline) {
      const before = stampsFromWorkers.size;
      await sweepWorkers(stampsFromWorkers);
      // Two workers can draw the same stamp, so settling below `threads` is
      // expected; a sweep that adds nothing means the pool is done booting.
      if (stampsFromWorkers.size === before) break;
    }
    if (stampsFromWorkers.size < 2) return; // dispatch never spread; nothing to prove

    const stampsFromBuffers = new Set<number>();
    await Promise.all(
      Array.from({ length: calls }, async () => {
        const sab = await pool.call.sabOwnStamped();
        stampsFromBuffers.add(new Uint8Array(sab as unknown as ArrayBuffer)[0]!);
      }),
    );

    // A worker that only booted in time for the buffer sweep is still a worker,
    // not corruption: confirm an unknown stamp against the pool before failing.
    if ([...stampsFromBuffers].some((stamp) => !stampsFromWorkers.has(stamp))) {
      await sweepWorkers(stampsFromWorkers);
    }

    for (const stamp of stampsFromBuffers) {
      assert.ok(
        stampsFromWorkers.has(stamp),
        `host read stamp ${stamp} that no worker reported`,
      );
    }
    assert.equal(
      stampsFromBuffers.size,
      stampsFromWorkers.size,
      "every worker's own buffer must survive the trip, not just the first one",
    );
  } finally {
    await pool.shutdown();
  }
});
