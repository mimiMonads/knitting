import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  getDefaultProcessSharedBufferPrimitives,
  parseProcessSharedBufferMetadata,
  ProcessSharedBuffer,
  setDefaultProcessSharedBufferPrimitives,
  type SharedMemoryMapping,
} from "../src/connections/index.ts";
import { createPool } from "../knitting.ts";
import {
  readInt32AtZero,
  writeSevenAndReadInt32,
} from "./fixtures/psb_tasks.ts";

const runtimePlatform = String(
  (globalThis as typeof globalThis & { Deno?: { build?: { os?: string } } })
    .Deno?.build?.os ??
    (globalThis as typeof globalThis & { process?: { platform?: string } })
      .process?.platform ??
    "",
);
const isWindows = runtimePlatform === "windows" || runtimePlatform === "win32";
const runtimeVersions = (globalThis as typeof globalThis & {
  process?: { versions?: { bun?: string } };
}).process?.versions;
const isBunMacOS = runtimePlatform === "darwin" &&
  typeof runtimeVersions?.bun === "string";
// Bun/macOS still fails reopening POSIX shm_open names through FFI. fchmod(2)
// cannot repair the mode there: Darwin shm descriptors are not vnodes, so it
// returns EINVAL. Unskip once the reopen errno identifies the real cause.
const bunMacOSNamedSharedMemorySkip = isBunMacOS
  ? "skipping named shared memory on Bun/macOS while shm_open reopen is investigated"
  : false;

const makeMapping = (
  sab = new SharedArrayBuffer(128),
  fd = 3,
): SharedMemoryMapping<SharedArrayBuffer> => ({
  runtime: "node",
  fd,
  size: sab.byteLength,
  byteLength: sab.byteLength,
  buffer: sab,
  kind: "shared-array-buffer",
  sab,
  baseAddressMod64: 0,
});

test("ProcessSharedBuffer default primitives do not reject Windows as POSIX-only", () => {
  if (!isWindows) return;

  try {
    setDefaultProcessSharedBufferPrimitives(undefined);
    try {
      getDefaultProcessSharedBufferPrimitives();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, /Linux and macOS only/);
    }
  } finally {
    setDefaultProcessSharedBufferPrimitives(undefined);
  }
});

test("ProcessSharedBuffer creates typed views over logical byte regions", () => {
  const sab = new SharedArrayBuffer(128);
  const whole = ProcessSharedBuffer.fromMapping(makeMapping(sab));
  const payload = whole.subbuffer(64, 16);

  assert.equal(payload.fd, 3);
  assert.equal(payload.size, 128);
  assert.equal(payload.byteOffset, 64);
  assert.equal(payload.byteLength, 16);

  const bytes = payload.bytes();
  assert.equal(bytes.buffer, sab);
  assert.equal(bytes.byteOffset, 64);
  assert.equal(bytes.byteLength, 16);

  bytes[0] = 7;
  assert.equal(new Uint8Array(sab)[64], 7);

  const cells = payload.view(Int32Array);
  assert.equal(cells.buffer, sab);
  assert.equal(cells.byteOffset, 64);
  assert.equal(cells.length, 4);
});

test("ProcessSharedBuffer subbuffers compose without losing descriptor metadata", () => {
  const whole = ProcessSharedBuffer.fromMapping(makeMapping());
  const nested = whole.subbuffer(16, 64).subbuffer(8, 16);

  assert.deepEqual(nested.toMetadata(), {
    version: 1,
    descriptor: {
      version: 1,
      fd: 3,
      size: 128,
      byteLength: 128,
      runtime: "node",
      kind: "shared-array-buffer",
      baseAddressMod64: 0,
    },
    byteOffset: 24,
    byteLength: 16,
  });

  assert.deepEqual(
    parseProcessSharedBufferMetadata(nested.stringifyMetadata()),
    nested.toMetadata(),
  );
});

test("ProcessSharedBuffer restores metadata and maps lazily", () => {
  const whole = ProcessSharedBuffer.fromMapping(makeMapping());
  const wire = whole.subbuffer(32, 32).stringifyMetadata();
  const restored = ProcessSharedBuffer.parse(wire);
  const mappedSab = new SharedArrayBuffer(128);

  try {
    setDefaultProcessSharedBufferPrimitives({
      createSharedMemory: () => makeMapping(),
      mapSharedMemory: ({ fd, size }) => makeMapping(mappedSab, fd + size),
    });

    const bytes = restored.bytes();

    assert.equal(bytes.buffer, mappedSab);
    assert.equal(bytes.byteOffset, 32);
    assert.equal(bytes.byteLength, 32);
  } finally {
    setDefaultProcessSharedBufferPrimitives(undefined);
  }
});

test("ProcessSharedBuffer creates mappings with default primitives", () => {
  const sab = new SharedArrayBuffer(128);

  try {
    setDefaultProcessSharedBufferPrimitives({
      createSharedMemory: () => makeMapping(sab, 9),
      mapSharedMemory: () => makeMapping(),
    });

    const created = ProcessSharedBuffer.create(64);
    const bytes = created.bytes();

    assert.equal(created.fd, 9);
    assert.equal(bytes.buffer, sab);
    assert.equal(bytes.byteOffset, 0);
    assert.equal(bytes.byteLength, 128);
  } finally {
    setDefaultProcessSharedBufferPrimitives(undefined);
  }
});

if (bunMacOSNamedSharedMemorySkip) {
  test.skip("ProcessSharedBuffer named mappings can reopen by name", () => {});
} else {
  test("ProcessSharedBuffer named mappings can reopen by name", () => {
    const primitives = getDefaultProcessSharedBufferPrimitives();
    if (typeof primitives.unlinkSharedMemory !== "function") return;

    // Keep name ≤ 30 chars for macOS POSIX shm_open limit.
    const name = `kpsb_${Date.now().toString(36).slice(-6)}_${
      Math.random().toString(36).slice(2, 8)
    }`;
    const owner = ProcessSharedBuffer.create({
      mode: "create",
      name,
      size: 64,
    }, primitives);

    try {
      Atomics.store(owner.view(Int32Array), 0, 42);
      const peer = ProcessSharedBuffer.create({
        mode: "open",
        name,
        size: 64,
      }, primitives);

      try {
        assert.equal(Atomics.load(peer.view(Int32Array), 0), 42);
        assert.equal(peer.descriptor.name, name);
      } finally {
        peer.descriptor.mapping?.close?.();
      }
    } finally {
      owner.descriptor.mapping?.close?.();
      primitives.unlinkSharedMemory(name);
    }
  });
}

test("ProcessSharedBuffer rejects out-of-bounds and unaligned views", () => {
  const whole = ProcessSharedBuffer.fromMapping(makeMapping());

  assert.throws(
    () => whole.subbuffer(129),
    /byteOffset is out of bounds/,
  );
  assert.throws(
    () => whole.subbuffer(120, 16),
    /byteLength is out of bounds/,
  );
  assert.throws(
    () => whole.subbuffer(1, 4).view(Int32Array),
    /byteOffset is not aligned/,
  );
  assert.throws(
    () => whole.subbuffer(4, 2).view(Int32Array),
    /byteLength is not aligned/,
  );
});

// Regression test: ProcessSharedBuffer tasks must work in Node.js thread workers.
//
// Root cause of the original bug: knitting_shared_memory.node used
// process-level V8 addon registration. The shared object can be cached after
// the main thread loads it, so worker threads need context-aware registration
// to initialize their own environment.
//
// This test catches the regression by:
//   1. Loading the native addon in the main thread via getDefaultProcessSharedBufferPrimitives().
//   2. Spinning up thread workers via createPool().
//   3. Calling a task that calls buffer.view() inside the worker, which requires
//      the addon to load inside the worker thread as well.
const runtimeVersionsForPsbPool = (globalThis as typeof globalThis & {
  process?: { versions?: { bun?: string; modules?: string } };
}).process?.versions;
const isNodeJsForPsbPool =
  typeof runtimeVersionsForPsbPool?.modules === "string" &&
  typeof runtimeVersionsForPsbPool?.bun === "undefined" &&
  typeof (globalThis as { Deno?: unknown }).Deno === "undefined";

if (isNodeJsForPsbPool) {
  test(
    "ProcessSharedBuffer tasks run in thread workers after main-thread native addon load",
    async () => {
      const primitives = getDefaultProcessSharedBufferPrimitives();

      const shared = ProcessSharedBuffer.create(64, primitives);
      Atomics.store(shared.view(Int32Array), 0, 99);

      const pool = createPool({ threads: 1 })({
        readInt32AtZero,
        writeSevenAndReadInt32,
      });
      try {
        // Worker must load the native addon independently of the main thread.
        const read = await pool.call.readInt32AtZero(shared);
        assert.equal(
          read,
          99,
          "worker should read the value written by main thread",
        );

        // Worker-side write must be visible back on the main thread.
        await pool.call.writeSevenAndReadInt32(shared);
        assert.equal(
          Atomics.load(shared.view(Int32Array), 0),
          7,
          "main thread should see the value written by the worker",
        );
      } finally {
        shared.descriptor.mapping?.close?.();
        await pool.shutdown();
      }
    },
  );
}
