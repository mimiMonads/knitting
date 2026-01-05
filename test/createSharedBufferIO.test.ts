import { assertEquals } from "jsr:@std/assert";
import {
  createSharedDynamicBufferIO,
  createSharedStaticBufferIO,
} from "../src/memory/createSharedBufferIO.ts";
import { LockBound, TaskIndex } from "../src/memory/lock.ts";

const header = 64;

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

Deno.test("writeBinary grows and reads back", () => {
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

Deno.test("writeUtf8 grows when buffer is too small", () => {
  const sab = makeSab(4);
  const io = createSharedDynamicBufferIO({ sab });
  const text = "hello-world-hello-world-hello-world";
  const encoded = new TextEncoder().encode(text);

  const written = io.writeUtf8(text,0);

  assertEquals(written, encoded.byteLength);
  assertEquals(io.readUtf8(0, written), text);
  assertEquals(sab.byteLength >= header + encoded.byteLength, true);
});

Deno.test("write8Binary writes Float64 values", () => {
  const sab = makeSab(8);
  const io = createSharedDynamicBufferIO({ sab });
  const values = new Float64Array([1.25, -2, 3.5]);

  const written = io.write8Binary(values);
  const readBack = new Float64Array(sab, header, values.length);

  assertEquals(written, values.byteLength);
  assertEquals(Array.from(readBack), Array.from(values));
});

Deno.test("writeBinary respects start offset and preserves earlier bytes", () => {
  const sab = makeSab(32);
  const io = createSharedDynamicBufferIO({ sab });
  const first = new Uint8Array([1, 2, 3, 4]);
  const second = new Uint8Array([9, 10]);

  io.writeBinary(first, 0);
  io.writeBinary(second, 8);

  assertEquals(Array.from(io.readBytesCopy(0, 4)), Array.from(first));
  assertEquals(Array.from(io.readBytesCopy(8, 10)), Array.from(second));
});

Deno.test("writeUtf8 does not grow when buffer is large enough", () => {
  const sab = makeSab(64);
  const io = createSharedDynamicBufferIO({ sab });
  const text = "short-text";
  const encoded = new TextEncoder().encode(text);
  const before = sab.byteLength;

  const written = io.writeUtf8(text, 0);

  assertEquals(written, encoded.byteLength);
  assertEquals(io.readUtf8(0, written), text);
  assertEquals(sab.byteLength, before);
});

Deno.test("readBytesCopy is isolated and readBytesView reflects writes", () => {
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

Deno.test("read8BytesFloat copy and view have expected semantics", () => {
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

Deno.test("static writeUtf8 preserves task header and reads back", () => {
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

Deno.test("static writeUtf8 returns -1 when it does not fit", () => {
  const headersBuffer = makeHeaders();
  const io = createSharedStaticBufferIO({ headersBuffer });
  const writableBytes =
    (TaskIndex.TotalBuff - TaskIndex.Size) * Uint32Array.BYTES_PER_ELEMENT;
  const tooLong = "a".repeat(writableBytes + 1);

  const written = io.writeUtf8(tooLong, 0);

  assertEquals(written, -1);
});

Deno.test("static binary and float IO roundtrip", () => {
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
