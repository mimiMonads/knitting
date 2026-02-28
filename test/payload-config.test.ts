import assert from "node:assert/strict";
import test from "node:test";
import {
  PAYLOAD_DEFAULT_MAX_BYTE_LENGTH,
  resolvePayloadBufferOptions,
} from "../src/memory/payload-config.ts";

test("payload config default maxPayloadBytes follows maxByteLength >> 3", () => {
  const out = resolvePayloadBufferOptions({
    options: { payloadMaxByteLength: 64 * 1024 * 1024 },
  });
  assert.equal(out.maxPayloadBytes, (64 * 1024 * 1024) >> 3);
});

test("payload config throws when maxPayloadBytes exceeds maxByteLength >> 3", () => {
  assert.throws(() => {
    resolvePayloadBufferOptions({
      options: {
        payloadMaxByteLength: 1024,
        maxPayloadBytes: 129,
      },
    });
  }, RangeError);
});

test("payload config throws when maxPayloadBytes is zero", () => {
  assert.throws(() => {
    resolvePayloadBufferOptions({
      options: {
        payloadMaxByteLength: 1024,
        maxPayloadBytes: 0,
      },
    });
  }, RangeError);
});

test("payload config falls back to fixed mode for non-growable SAB input", () => {
  const sab = new SharedArrayBuffer(4096);
  const out = resolvePayloadBufferOptions({
    sab,
    options: {
      mode: "growable",
      payloadMaxByteLength: 8192,
      maxPayloadBytes: 512,
    },
  });

  assert.equal(out.mode, "fixed");
  assert.equal(out.payloadInitialBytes, 8192);
});

test("payload config defaults stay stable when options are omitted", () => {
  const out = resolvePayloadBufferOptions({});
  assert.equal(out.payloadMaxByteLength, PAYLOAD_DEFAULT_MAX_BYTE_LENGTH);
  assert.equal(
    out.maxPayloadBytes,
    PAYLOAD_DEFAULT_MAX_BYTE_LENGTH >> 3,
  );
});
