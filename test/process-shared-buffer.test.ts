import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProcessSharedBufferMetadata,
  ProcessSharedBuffer,
  setDefaultProcessSharedBufferPrimitives,
  type SharedMemoryMapping,
} from "../src/connections/index.ts";

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
