import assert from "node:assert/strict";
import test from "node:test";
const assertEquals: (actual: unknown, expected: unknown) => void =
  (actual, expected) => {
    assert.deepStrictEqual(actual, expected);
  };
import {
  createSharedDynamicBufferIO,
  createSharedStaticBufferIO,
} from "../src/memory/createSharedBufferIO.ts";
import { LockBound, TaskIndex } from "../src/memory/lock.ts";

const header = 64;
const staticWritableBytes =
  (TaskIndex.TotalBuff - TaskIndex.Size) * Uint32Array.BYTES_PER_ELEMENT;
const textEncode = new TextEncoder();

const makeRng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
};

const makeSab = (payloadBytes: number) =>
  new SharedArrayBuffer(
    header + payloadBytes,
    { maxByteLength: header + 1024 * 1024 },
  );
const makeHeaders = () =>
  new SharedArrayBuffer(
    LockBound.padding +
      ((LockBound.slots * TaskIndex.TotalBuff)) * LockBound.slots,
  );

test("writeBinary grows and reads back", () => {
  const sab = makeSab(8);
  const io = createSharedDynamicBufferIO({ sab });
  const data = new Uint8Array(2048);

  for (let i = 0; i < data.length; i++) data[i] = i & 255;

  const written = io.writeBinary(data);

  assertEquals(written, data.byteLength);
  assertEquals(sab.byteLength >= header + data.byteLength, true);
  assertEquals(sab.byteLength % 64, 0);
  assertEquals(Array.from(io.readBytesCopy(0, written)), Array.from(data));
  assertEquals(Array.from(io.readBytesView(0, written)), Array.from(data));
});

test("writeUtf8 grows when buffer is too small", () => {
  const sab = makeSab(4);
  const io = createSharedDynamicBufferIO({ sab });
  const text = "hello-world-hello-world-hello-world";
  const encoded = new TextEncoder().encode(text);

  const written = io.writeUtf8(text,0);

  assertEquals(written, encoded.byteLength);
  assertEquals(io.readUtf8(0, written), text);
  assertEquals(sab.byteLength >= header + encoded.byteLength, true);
});

test("write8Binary writes Float64 values", () => {
  const sab = makeSab(8);
  const io = createSharedDynamicBufferIO({ sab });
  const values = new Float64Array([1.25, -2, 3.5]);

  const written = io.write8Binary(values);
  const readBack = new Float64Array(sab, header, values.length);

  assertEquals(written, values.byteLength);
  assertEquals(Array.from(readBack), Array.from(values));
});

test("writeBinary respects start offset and preserves earlier bytes", () => {
  const sab = makeSab(32);
  const io = createSharedDynamicBufferIO({ sab });
  const first = new Uint8Array([1, 2, 3, 4]);
  const second = new Uint8Array([9, 10]);

  io.writeBinary(first, 0);
  io.writeBinary(second, 8);

  assertEquals(Array.from(io.readBytesCopy(0, 4)), Array.from(first));
  assertEquals(Array.from(io.readBytesCopy(8, 10)), Array.from(second));
});

test("writeUtf8 does not grow when buffer is large enough", () => {
  const sab = makeSab(64);
  const io = createSharedDynamicBufferIO({ sab });
  const text = "short-text";
  const encoded = textEncode.encode(text);
  const before = sab.byteLength;

  const written = io.writeUtf8(text, 0);

  assertEquals(written, encoded.byteLength);
  assertEquals(io.readUtf8(0, written), text);
  assertEquals(sab.byteLength, before);
});

test("dynamic fixed mode returns -1 on binary overflow", () => {
  const sab = new SharedArrayBuffer(header + 32);
  const io = createSharedDynamicBufferIO({
    sab,
    payloadConfig: {
      mode: "fixed",
      payloadMaxByteLength: 1024 * 1024,
      maxPayloadBytes: 256,
    },
  });
  const src = new Uint8Array(64);

  const written = io.writeBinary(src, 0);

  assertEquals(written, -1);
});

test("dynamic fixed mode returns -1 on utf8 overflow", () => {
  const sab = new SharedArrayBuffer(header + 32);
  const io = createSharedDynamicBufferIO({
    sab,
    payloadConfig: {
      mode: "fixed",
      payloadMaxByteLength: 1024 * 1024,
      maxPayloadBytes: 256,
    },
  });

  const written = io.writeUtf8("a".repeat(80), 0, 80);

  assertEquals(written, -1);
});

test("dynamic writeUtf8 honors exact reserved bytes and start offsets", () => {
  const sab = makeSab(64);
  const io = createSharedDynamicBufferIO({ sab });
  const cases = [
    "abcXYZ",
    "é".repeat(11),
    "€€€-edge",
    "😀𐍈हЖmix",
    "",
  ];

  let cursor = 7;
  for (const text of cases) {
    const encoded = textEncode.encode(text);
    const written = io.writeUtf8(text, cursor, encoded.byteLength);
    assertEquals(written, encoded.byteLength);
    assertEquals(io.readUtf8(cursor, cursor + written), text);
    cursor += written + 5;
  }
});

test("readBytesCopy is isolated and readBytesView reflects writes", () => {
  const sab = makeSab(32);
  const io = createSharedDynamicBufferIO({ sab });
  const initial = new Uint8Array([7, 8, 9, 10]);

  io.writeBinary(initial, 0);
  const copy = io.readBytesCopy(0, 4);
  const view = io.readBytesView(0, 4);

  io.writeBinary(new Uint8Array([1, 2, 3, 4]), 0);

  assertEquals(Array.from(copy), Array.from(initial));
  assertEquals(Array.from(view), [1, 2, 3, 4]);
});

test("read8BytesFloat copy and view have expected semantics", () => {
  const sab = makeSab(64);
  const io = createSharedDynamicBufferIO({ sab });
  const initial = new Float64Array([0.5, -1.5, 2.25]);

  io.write8Binary(initial, 0);
  const copy = io.read8BytesFloatCopy(0, initial.byteLength);
  const view = io.read8BytesFloatView(0, initial.byteLength);

  io.write8Binary(new Float64Array([3.25, 4.5, -6]), 0);

  assertEquals(Array.from(copy), Array.from(initial));
  assertEquals(Array.from(view), [3.25, 4.5, -6]);
});

test("static writeUtf8 preserves task header and reads back", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const headersU32 = new Uint32Array(headersBuffer);
  const slotStride = LockBound.padding + TaskIndex.TotalBuff;
  const slotOffset = (at: number) => (at * slotStride) + LockBound.padding;
  const slot = 0;
  const marker = 0xdeadbeef;

  for (let i = 0; i < TaskIndex.Size; i++) {
    headersU32[slotOffset(slot) + i] = marker;
  }

  const text = "hello";
  const written = io.writeUtf8(text, slot);

  assertEquals(written, new TextEncoder().encode(text).byteLength);
  for (let i = 0; i < TaskIndex.Size; i++) {
    assertEquals(headersU32[slotOffset(slot) + i], marker);
  }
  assertEquals(io.readUtf8(0, written, slot), text);
});

test("static writeUtf8 returns -1 when it does not fit", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const tooLong = "a".repeat(staticWritableBytes + 1);

  const written = io.writeUtf8(tooLong, 0);

  assertEquals(written, -1);
});

test("static writeUtf8 accepts exact utf8 byte boundary with multibyte chars", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const text = "😀".repeat(staticWritableBytes >>> 2);

  const written = io.writeUtf8(text, 0);

  assertEquals(written, staticWritableBytes);
  assertEquals(io.readUtf8(0, written, 0), text);
});

test("static writeUtf8 can partially mutate slot on multibyte overflow (full boundary fill)", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const slot = 0;
  const marker = 0x5a;
  const initial = new Uint8Array(staticWritableBytes).fill(marker);
  const text = "😀".repeat((staticWritableBytes >>> 2) + 1);
  const encoded = new TextEncoder().encode(text);
  const encodedBytes = encoded.byteLength;

  assertEquals(text.length <= staticWritableBytes, true);
  assertEquals(encodedBytes > staticWritableBytes, true);

  io.writeBinary(initial, slot, 0);
  const written = io.writeUtf8(text, slot);
  const out = io.readBytesCopy(0, staticWritableBytes, slot);

  assertEquals(written, -1);
  assertEquals(Array.from(out), Array.from(encoded.subarray(0, staticWritableBytes)));
});

test("static writeUtf8 can partially mutate slot on multibyte overflow (below boundary fill)", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const slot = 1;
  const marker = 0x33;
  const initial = new Uint8Array(staticWritableBytes).fill(marker);
  const text =
    "€".repeat(Math.floor((staticWritableBytes - 1) / 3)) +
    "é".repeat(2);
  const encoded = new TextEncoder().encode(text);
  const encodedBytes = encoded.byteLength;
  const partialPrefixBytes = staticWritableBytes - 1;

  assertEquals(text.length <= staticWritableBytes, true);
  assertEquals(encodedBytes, staticWritableBytes + 1);

  io.writeBinary(initial, slot, 0);
  const written = io.writeUtf8(text, slot);
  const out = io.readBytesCopy(0, staticWritableBytes, slot);

  assertEquals(written, -1);
  assertEquals(
    Array.from(out.subarray(0, partialPrefixBytes)),
    Array.from(encoded.subarray(0, partialPrefixBytes)),
  );
  assertEquals(out[partialPrefixBytes], marker);
});

test("static writeUtf8 can partially mutate slot on ASCII overflow", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const slot = 2;
  const marker = 0x19;
  const initial = new Uint8Array(staticWritableBytes).fill(marker);
  const text = "q".repeat(staticWritableBytes + 9);

  io.writeBinary(initial, slot, 0);
  const written = io.writeUtf8(text, slot);
  const out = io.readBytesCopy(0, staticWritableBytes, slot);

  assertEquals(written, -1);
  assertEquals(Array.from(out), Array.from(textEncode.encode("q".repeat(staticWritableBytes))));
});

test("static writeUtf8 recovers after overflow by accepting subsequent fitting writes", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const slot = 3;

  assertEquals(io.writeUtf8("😀".repeat((staticWritableBytes >>> 2) + 1), slot), -1);

  const next = "ok-😀-post-overflow";
  const expected = textEncode.encode(next);
  const written = io.writeUtf8(next, slot);

  assertEquals(written, expected.byteLength);
  assertEquals(io.readUtf8(0, written, slot), next);
});

test("static writeUtf8 writes are isolated per slot", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const marker = 0x7f;
  const untouched = new Uint8Array(staticWritableBytes).fill(marker);
  io.writeBinary(untouched, 0, 0);

  const text = "slot-one-😀";
  const written = io.writeUtf8(text, 1);

  assertEquals(io.readUtf8(0, written, 1), text);
  assertEquals(Array.from(io.readBytesCopy(0, staticWritableBytes, 0)), Array.from(untouched));
});

test("static writeUtf8 randomized boundary behavior matches encodeInto contract", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const nextRandom = makeRng(0x51a71c0d);
  const alphabet = ["a", "b", "é", "€", "Ж", "ह", "😀", "𐍈"];

  for (let i = 0; i < 400; i++) {
    let text = "";
    const targetLen = staticWritableBytes - 24 + (nextRandom() % 64);
    for (let at = 0; at < targetLen; at++) {
      text += alphabet[nextRandom() % alphabet.length]!;
    }

    const slot = i % LockBound.slots;
    const probe = new Uint8Array(staticWritableBytes);
    const probeResult = textEncode.encodeInto(text, probe);
    const written = io.writeUtf8(text, slot);

    if (probeResult.read === text.length) {
      assertEquals(written, probeResult.written);
      assertEquals(io.readUtf8(0, written, slot), text);
      continue;
    }

    assertEquals(written, -1);
    assertEquals(
      Array.from(io.readBytesCopy(0, probeResult.written, slot)),
      Array.from(probe.subarray(0, probeResult.written)),
    );
  }
});

test("static binary and float IO roundtrip", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const slot = 0;

  const bytes = new Uint8Array([10, 20, 30, 40, 50]);
  const writtenBytes = io.writeBinary(bytes, slot, 4);
  assertEquals(writtenBytes, bytes.byteLength);
  assertEquals(Array.from(io.readBytesCopy(4, 9, slot)), Array.from(bytes));
  assertEquals(Array.from(io.readBytesView(4, 9, slot)), Array.from(bytes));

  const floats = new Float64Array([1.5, -2.25, 3.75]);
  const writtenFloats = io.write8Binary(floats, slot, 16);
  assertEquals(writtenFloats, floats.byteLength);
  assertEquals(
    Array.from(io.read8BytesFloatCopy(16, 16 + floats.byteLength, slot)),
    Array.from(floats),
  );
  assertEquals(
    Array.from(io.read8BytesFloatView(16, 16 + floats.byteLength, slot)),
    Array.from(floats),
  );
});
