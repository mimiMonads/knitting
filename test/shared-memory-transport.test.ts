import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  createSharedMemoryTransport,
  TRANSPORT_SIGNAL_BYTES,
} from "../src/ipc/transport/shared-memory.ts";

test("shared memory transport honors region offsets", () => {
  const prefixBytes = 64;
  // Size the region to exactly what the transport claims to need, so a signal
  // added past the end fails here instead of silently running off into
  // whatever the backing buffer happens to have spare.
  const backing = new SharedArrayBuffer(prefixBytes + TRANSPORT_SIGNAL_BYTES);

  const signals = createSharedMemoryTransport({
    sabObject: {
      sharedSab: {
        sab: backing,
        byteOffset: prefixBytes,
        byteLength: TRANSPORT_SIGNAL_BYTES,
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
  // Every signal keeps its own cache line, and the last one has to fit.
  assert.equal(signals.stopView.byteOffset, prefixBytes + 192);
  assert.ok(
    signals.stopView.byteOffset + signals.stopView.byteLength <=
      prefixBytes + TRANSPORT_SIGNAL_BYTES,
    "the transport wrote past the region it asked for",
  );
});
