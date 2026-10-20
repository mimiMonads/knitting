import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
// Knitting captures and removes the public gc hook during initialization. Keep
// a private reference before importing it. Worker bootstrap may already have
// hidden it; a fresh context in that isolate exposes the same --expose-gc hook.
const exposedGc = globalThis.gc ?? runInNewContext(
  'typeof gc === "function" ? gc : undefined',
);
const { createPool, isMain, task } = await import("__KNITTING_ENTRY__");
import { getDefaultProcessSharedBufferPrimitives } from "__KNITTING_SHARED__";

export const increment = task({ f: (value) => value + 1 });
export const inspectBytes = task({
  f: (value) => {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let checksum = bytes[bytes.length - 1] ?? 0;
    for (let i = 0; i < bytes.length; i += 4096) checksum += bytes[i];
    return [bytes.length, checksum];
  },
});
export const returnFreshShared = task({
  f: (seed) => {
    const buffer = new SharedArrayBuffer(1024 * 1024);
    new Uint8Array(buffer).fill(seed);
    return buffer;
  },
});
export const collectWorker = task({
  f: () => {
    if (typeof exposedGc !== "function") {
      throw new Error("Worker GC hook unavailable");
    }
    exposedGc();
    return true;
  },
});

const MiB = 1024 * 1024;
const poolOptions = {
  threads: 1,
  permission: "unsafe",
  payload: {
    payloadInitialBytes: 4 * MiB,
    payloadMaxByteLength: 16 * MiB,
    maxPayloadBytes: 2 * MiB,
  },
};
const expected = (seed) => [MiB, seed * (MiB / 4096 + 1)];
const makeBytes = (shared, seed) => {
  const buffer = shared ? new SharedArrayBuffer(MiB) : new ArrayBuffer(MiB);
  const bytes = new Uint8Array(buffer);
  bytes.fill(seed);
  return shared ? buffer : bytes;
};
const memory = () => {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, external, arrayBuffers };
};
const gc = async () => {
  for (let i = 0; i < 3; i++) {
    await nextTurn();
    exposedGc();
  }
};

if (isMain) {
  const [output, iterationsText, warmupText, buffersText, roundText] = process
    .argv.slice(2);
  const iterations = Number(iterationsText);
  const warmup = Number(warmupText);
  const memoryBuffers = Number(buffersText);
  const round = Number(roundText);
  const result = {
    schemaVersion: 1,
    correctness: [],
    benchmarks: {},
    memory: null,
  };
  // Save partial results too: a failed run must remain inspectable.
  const save = () =>
    writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  const measure = async (name, operation, validate) => {
    for (let i = 0; i < warmup; i++) validate(await operation(i));
    const samplesNs = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const value = await operation(i);
      samplesNs.push((performance.now() - start) * 1e6);
      validate(value); // Validation is outside the measured interval.
    }
    result.benchmarks[name] = { unit: "ns/op", samplesNs };
    save();
  };
  try {
    assert.equal(typeof exposedGc, "function", "run with --expose-gc");
    const pool = createPool(poolOptions)({ increment, inspectBytes });
    try {
      assert.equal(await pool.call.increment(41), 42);
      result.correctness.push("scalar task returns the expected value");
      const reused = makeBytes(true, 7);
      const copied = makeBytes(false, 7);
      const cases = [
        [
          "warm_scalar",
          () => pool.call.increment(41),
          (value) => assert.equal(value, 42),
        ],
        [
          "reused_shared_1mib",
          () => pool.call.inspectBytes(reused),
          (value) => assert.deepEqual(value, expected(7)),
        ],
        [
          "fresh_shared_1mib",
          () => pool.call.inspectBytes(makeBytes(true, 7)),
          (value) => assert.deepEqual(value, expected(7)),
        ],
        [
          "copied_bytes_1mib",
          () => pool.call.inspectBytes(copied),
          (value) => assert.deepEqual(value, expected(7)),
        ],
      ];
      // Rotate cases between independent runs as well as alternating versions.
      for (
        const entry of [
          ...cases.slice(round % cases.length),
          ...cases.slice(0, round % cases.length),
        ]
      ) {
        await measure(...entry);
      }
      result.correctness.push(
        "copied, reused shared, and fresh shared payloads have the expected size and page checksum",
      );
    } finally {
      await pool.shutdown();
    }
    result.correctness.push("thread pool shuts down");
    await gc();

    const primitives = getDefaultProcessSharedBufferPrimitives();
    const owner = primitives.createSharedMemory(4096);
    try {
      new Uint8Array(owner.buffer)[0] = 73;
      await measure("mapping_4kib", () => {
        const peer = primitives.mapSharedMemory({ fd: owner.fd, size: 4096 });
        const value = new Uint8Array(peer.buffer)[0];
        peer.close?.();
        return value;
      }, (value) => assert.equal(value, 73));
      result.correctness.push("mapped memory aliases the original bytes");
    } finally {
      owner.close?.();
    }
    await gc();

    const memoryPool = createPool(poolOptions)({
      returnFreshShared,
      collectWorker,
    });
    try {
      // Warm startup before the baseline snapshot.
      const workerGcAvailable = await memoryPool.call.collectWorker();
      await gc();
      result.memory = {
        gc: { host: true, worker: workerGcAvailable },
        unit: "bytes",
        bufferBytes: MiB,
        buffers: memoryBuffers,
        before: memory(),
        checkpoints: [],
      };
      for (let i = 1; i <= memoryBuffers; i++) {
        const seed = i % 251;
        const returned = await memoryPool.call.returnFreshShared(seed);
        const bytes = new Uint8Array(returned);
        assert.equal(bytes.length, MiB);
        assert.equal(bytes[0], seed);
        assert.equal(bytes[MiB - 1], seed);
        // Let the returned alias leave scope before collecting on a later turn.
        if (i % Math.max(1, Math.floor(memoryBuffers / 4)) === 0) {
          await memoryPool.call.collectWorker();
          await gc();
          result.memory.checkpoints.push({ completed: i, ...memory() });
          save();
        }
      }
      await memoryPool.call.collectWorker();
      await gc();
      result.memory.after = memory();
      result.correctness.push("fresh shared returns preserve their bytes");
    } finally {
      await memoryPool.shutdown();
    }
    await gc();
    result.memory.afterShutdown = memory();
    result.correctness.push("memory workload pool shuts down");
    result.ok = true;
    save();
  } catch (error) {
    result.ok = false;
    result.error = error.stack ?? String(error);
    save();
    throw error;
  }
}
