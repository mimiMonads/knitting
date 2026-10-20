import assert from "node:assert/strict";
import test from "./_runner.ts";
import { getDefaultProcessSharedBufferPrimitives } from "../src/connections/process-shared-buffer.ts";

const platform = process.platform;
const posix = platform === "linux" || platform === "darwin";

test("shared memory rejects a mapping beyond the backing object's size", {
  skip: !posix,
}, () => {
  const primitives = getDefaultProcessSharedBufferPrimitives();
  const owner = primitives.createSharedMemory(64);
  try {
    assert.throws(
      () => primitives.mapSharedMemory({ fd: owner.fd, size: 8192 }),
      /mapping exceeds backing size/,
    );
    // Failed mapping must not consume the caller's descriptor.
    const peer = primitives.mapSharedMemory({ fd: owner.fd, size: 64 });
    new Uint8Array(peer.buffer)[0] = 73;
    assert.equal(new Uint8Array(owner.buffer)[0], 73);
    peer.close?.();
  } finally {
    owner.close?.();
  }
});

test(
  "external mapping close invalidates aliases and cannot close a reused descriptor",
  { skip: !posix },
  () => {
    const primitives = getDefaultProcessSharedBufferPrimitives();
    const mapping = primitives.createSharedMemory(4096);
    if (mapping.close === undefined) return; // Node's V8 addon owns lifetime via GC.
    const view = new Uint8Array(mapping.buffer);
    const slice = view.subarray(8, 16);
    mapping.close();
    assert.equal(view.byteLength, 0);
    assert.equal(slice.byteLength, 0);
    const next = primitives.createSharedMemory(64);
    try {
      mapping.close();
      const peer = primitives.mapSharedMemory({ fd: next.fd, size: 64 });
      peer.close?.();
    } finally {
      next.close?.();
    }
  },
);

test("named open also rejects a mapping beyond the backing size", {
  skip: !posix,
}, () => {
  const primitives = getDefaultProcessSharedBufferPrimitives();
  const name = `safety_${process.pid}_${Date.now().toString(36)}`;
  const owner = primitives.createSharedMemory({
    size: 64,
    mode: "create",
    name,
  });
  try {
    assert.throws(
      () => primitives.createSharedMemory({ size: 8192, mode: "open", name }),
      /mapping exceeds backing size/,
    );
  } finally {
    owner.close?.();
    primitives.unlinkSharedMemory?.(name);
  }
});
