import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  type BufferLike,
  bufferToBytes,
  bufferToJson,
  bufferToNumbers,
  bufferToString,
  bytesToBuffer,
  jsonToBuffer,
  numbersToBuffer,
  stringToBuffer,
} from "../utils.ts";

test("bytesToBuffer copies raw byte views into a SharedArrayBuffer", () => {
  const padded = Uint8Array.of(9, 1, 2, 3, 9);
  const source = padded.subarray(1, 4);
  const sab = bytesToBuffer(source);

  assert.ok(sab instanceof SharedArrayBuffer);
  assert.deepEqual(Array.from(new Uint8Array(sab)), [1, 2, 3]);

  source[0] = 99;
  assert.deepEqual(Array.from(new Uint8Array(sab)), [1, 2, 3]);
});

test("bufferToBytes returns a byte view over buffer-like inputs", () => {
  const sab = bytesToBuffer(Uint8Array.of(4, 5, 6));
  const bytes = bufferToBytes(sab);

  bytes[1] = 9;
  assert.deepEqual(Array.from(new Uint8Array(sab)), [4, 9, 6]);

  const data = new DataView(bytesToBuffer(Uint8Array.of(7, 8, 9, 10)), 1, 2);
  assert.deepEqual(Array.from(bufferToBytes(data)), [8, 9]);
});

test("numbersToBuffer packs f64 by default and round-trips", () => {
  const input = [1, 2.5, -3, 4e10, 0];
  const sab = numbersToBuffer(input);

  assert.ok(sab instanceof SharedArrayBuffer);
  assert.equal(sab.byteLength, input.length * 8);

  const out = bufferToNumbers(sab);
  assert.ok(out instanceof Float64Array);
  assert.deepEqual(Array.from(out), input);
});

test("numbersToBuffer honors f32 and i32 formats", () => {
  const f32 = numbersToBuffer([1, 2, 3], { format: "f32" });
  assert.equal(f32.byteLength, 3 * 4);
  assert.deepEqual(
    Array.from(bufferToNumbers(f32, { format: "f32" })),
    [1, 2, 3],
  );

  const i32 = numbersToBuffer([10, -20, 30], { format: "i32" });
  assert.equal(i32.byteLength, 3 * 4);
  const back = bufferToNumbers(i32, { format: "i32" });
  assert.ok(back instanceof Int32Array);
  assert.deepEqual(Array.from(back), [10, -20, 30]);
});

test("numbersToBuffer accepts typed arrays as input", () => {
  const sab = numbersToBuffer(Float64Array.of(7, 8, 9));
  assert.deepEqual(Array.from(bufferToNumbers(sab)), [7, 8, 9]);
});

test("bufferToNumbers throws on a length that is not a whole element", () => {
  const sab = new SharedArrayBuffer(12);
  assert.throws(() => bufferToNumbers(sab), /multiple of 8/);
});

test("bufferToNumbers copies when the view offset is misaligned", () => {
  const backing = new Uint8Array(numbersToBuffer([1, 2]));
  const padded = new Uint8Array(backing.byteLength + 1);
  padded.set(backing, 1);
  const misaligned = padded.subarray(1);

  const out = bufferToNumbers(misaligned);
  assert.deepEqual(Array.from(out), [1, 2]);
});

test("string round-trips through a SharedArrayBuffer (utf-8)", () => {
  const text = "hello — café 🧶";
  const sab = stringToBuffer(text);

  assert.ok(sab instanceof SharedArrayBuffer);
  assert.equal(bufferToString(sab), text);
});

test("bufferToString reads typed-array views", () => {
  const text = "knitting";
  const u8 = new Uint8Array(stringToBuffer(text));
  assert.equal(bufferToString(u8), text);
  assert.equal(bufferToString(u8.buffer), text);
});

test("json round-trips through a SharedArrayBuffer", () => {
  const value = { a: 1, b: [true, null, "x"], c: { nested: 2.5 } };
  const sab = jsonToBuffer(value);

  assert.ok(sab instanceof SharedArrayBuffer);
  assert.deepEqual(bufferToJson(sab), value);
});

test("jsonToBuffer rejects values that are not JSON-serializable", () => {
  assert.throws(() => jsonToBuffer(undefined), /not JSON-serializable/);
  assert.throws(() => jsonToBuffer(() => {}), /not JSON-serializable/);
});

test("bufferToString rejects non-buffer inputs", () => {
  assert.throws(
    () => bufferToString("nope" as unknown as BufferLike),
    /ArrayBuffer/,
  );
});
