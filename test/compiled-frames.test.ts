import assert from "node:assert/strict";
import test from "./_runner.ts";
import { CompiledResponseFrames } from "../src/runtime/compiled-frames.ts";

const jsonFrame = (status: number, text: string): Uint8Array => {
  const payload = new TextEncoder().encode(text);
  const bytes = new Uint8Array(8 + payload.length);
  const header = new DataView(bytes.buffer);
  header.setInt32(0, status, true);
  header.setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
};

test("compiled response framing handles fragmented headers, payloads, and coalesced frames", () => {
  const frames = [
    jsonFrame(0, '{"ok":true}'),
    jsonFrame(3, ""),
    jsonFrame(0, '"Héllo"'),
  ];
  const stream = new Uint8Array(
    frames.reduce((size, frame) => size + frame.length, 0),
  );
  let at = 0;
  for (const frame of frames) {
    stream.set(frame, at);
    at += frame.length;
  }
  // Every possible two-chunk boundary, including a chunk ending exactly on a
  // header, plus one-byte fragmentation and the fully coalesced stream.
  for (let split = 0; split <= stream.length; split++) {
    const received: unknown[] = [];
    const decoder = new TextDecoder();
    const reader = new CompiledResponseFrames(true, 1024, (status, payload) => {
      received.push([status, decoder.decode(payload)]);
    });
    reader.push(stream.subarray(0, split));
    reader.push(stream.subarray(split));
    assert.deepEqual(received, [[0, '{"ok":true}'], [3, ""], [0, '"Héllo"']]);
  }
  const statuses: number[] = [];
  const reader = new CompiledResponseFrames(
    true,
    1024,
    (status) => statuses.push(status),
  );
  for (const byte of stream) reader.push(new Uint8Array([byte]));
  assert.deepEqual(statuses, [0, 3, 0]);
});

test("compiled numeric response framing survives every header split", () => {
  const frame = new Uint8Array(16);
  const header = new DataView(frame.buffer);
  header.setInt32(0, 0, true);
  header.setFloat64(8, 42.5, true);
  for (let split = 0; split <= 16; split++) {
    const received: number[] = [];
    const reader = new CompiledResponseFrames(
      false,
      1024,
      (status, payload) => {
        assert.equal(status, 0);
        received.push(
          new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
            .getFloat64(0, true),
        );
      },
    );
    reader.push(frame.subarray(0, split));
    reader.push(frame.subarray(split));
    assert.deepEqual(received, [42.5]);
  }
});

test("compiled response framing rejects an oversized length before collecting the payload", () => {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(4, 1025, true);
  const reader = new CompiledResponseFrames(
    true,
    1024,
    () => assert.fail("unexpected response"),
  );
  reader.push(header.subarray(0, 7));
  assert.throws(() => reader.push(header.subarray(7)), /oversized response/);
});
