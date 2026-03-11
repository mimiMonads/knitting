import assert from "node:assert/strict";
import test from "node:test";
import { createSharedMemoryTransport } from "../src/ipc/transport/shared-memory.ts";

test("shared memory transport honors region offsets", () => {
  const prefixBytes = 64;
  const backing = new SharedArrayBuffer(prefixBytes + 256);

  const signals = createSharedMemoryTransport({
    sabObject: {
      sharedSab: {
        sab: backing,
        byteOffset: prefixBytes,
        byteLength: 192,
      },
    },
    isMain: true,
    thread: 0,
  });

  assert.deepEqual(
    Array.from(new Uint8Array(backing, 0, prefixBytes)),
    Array.from(new Uint8Array(prefixBytes)),
  );
  assert.equal(signals.opView.byteOffset, prefixBytes);
  assert.equal(signals.rxStatus.byteOffset, prefixBytes + 64);
  assert.equal(signals.txStatus.byteOffset, prefixBytes + 128);
});
