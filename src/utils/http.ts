type NodeBufferLike = Uint8Array & {
  toString: (encoding?: string) => string;
  write: (text: string, encoding?: string) => number;
};

type NodeBufferClass = {
  byteLength: (value: string, encoding?: string) => number;
  from: (
    buffer: ArrayBufferLike,
    byteOffset?: number,
    length?: number,
  ) => NodeBufferLike;
};

const nodeBuffer = (globalThis as typeof globalThis & {
  Buffer?: NodeBufferClass;
}).Buffer;

const hasNodeBuffer = typeof nodeBuffer?.from === "function" &&
  typeof nodeBuffer?.byteLength === "function";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const hasSharedArrayBuffer = typeof SharedArrayBuffer === "function";

const isSharedArrayBuffer = (value: unknown): value is SharedArrayBuffer =>
  hasSharedArrayBuffer && value instanceof SharedArrayBuffer;

export type BufferLike = ArrayBuffer | SharedArrayBuffer | ArrayBufferView;

export type NumberFormat = "f64" | "f32" | "i32";

export type NumberBufferOptions = {
  format?: NumberFormat;
};

const BYTES_PER_ELEMENT: Record<NumberFormat, number> = {
  f64: 8,
  f32: 4,
  i32: 4,
};

const toBytes = (source: BufferLike): Uint8Array => {
  if (source instanceof Uint8Array) return source;
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  if (source instanceof ArrayBuffer || isSharedArrayBuffer(source)) {
    return new Uint8Array(source);
  }
  throw new TypeError(
    "Expected an ArrayBuffer, SharedArrayBuffer, or typed-array view.",
  );
};

export const bufferToBytes = (source: BufferLike): Uint8Array =>
  toBytes(source);

export const bytesToBuffer = (source: BufferLike): SharedArrayBuffer => {
  const bytes = toBytes(source);
  const sab = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(sab).set(bytes);
  return sab;
};

const makeNumberView = (
  format: NumberFormat,
  buffer: ArrayBufferLike,
  byteOffset: number,
  length: number,
): Float64Array | Float32Array | Int32Array => {
  switch (format) {
    case "f64":
      return new Float64Array(buffer, byteOffset, length);
    case "f32":
      return new Float32Array(buffer, byteOffset, length);
    case "i32":
      return new Int32Array(buffer, byteOffset, length);
  }
};

export const bufferToString = (source: BufferLike): string => {
  const bytes = toBytes(source);
  if (hasNodeBuffer) {
    return nodeBuffer!
      .from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .toString("utf8");
  }
  return textDecoder.decode(bytes);
};

export const stringToBuffer = (text: string): SharedArrayBuffer => {
  if (typeof text !== "string") {
    throw new TypeError("stringToBuffer expects a string.");
  }
  if (hasNodeBuffer) {
    const byteLength = nodeBuffer!.byteLength(text, "utf8");
    const sab = new SharedArrayBuffer(byteLength);
    nodeBuffer!.from(sab).write(text, "utf8");
    return sab;
  }
  const encoded = textEncoder.encode(text);
  const sab = new SharedArrayBuffer(encoded.byteLength);
  new Uint8Array(sab).set(encoded);
  return sab;
};

export const bufferToJson = <T = unknown>(source: BufferLike): T =>
  JSON.parse(bufferToString(source)) as T;

export const jsonToBuffer = (value: unknown): SharedArrayBuffer => {
  const text = JSON.stringify(value);
  if (typeof text !== "string") {
    throw new TypeError(
      "jsonToBuffer: value is not JSON-serializable (stringify returned undefined).",
    );
  }
  return stringToBuffer(text);
};

export const numbersToBuffer = (
  numbers: ArrayLike<number>,
  options?: NumberBufferOptions,
): SharedArrayBuffer => {
  const format = options?.format ?? "f64";
  const sab = new SharedArrayBuffer(numbers.length * BYTES_PER_ELEMENT[format]);
  makeNumberView(format, sab, 0, numbers.length).set(numbers);
  return sab;
};

export function bufferToNumbers(
  source: BufferLike,
  options?: { format?: "f64" },
): Float64Array;
export function bufferToNumbers(
  source: BufferLike,
  options: { format: "f32" },
): Float32Array;
export function bufferToNumbers(
  source: BufferLike,
  options: { format: "i32" },
): Int32Array;
export function bufferToNumbers(
  source: BufferLike,
  options?: NumberBufferOptions,
): Float64Array | Float32Array | Int32Array {
  const format = options?.format ?? "f64";
  const bytesPer = BYTES_PER_ELEMENT[format];
  const bytes = toBytes(source);
  if (bytes.byteLength % bytesPer !== 0) {
    throw new RangeError(
      `bufferToNumbers: byte length ${bytes.byteLength} is not a multiple of ` +
        `${bytesPer} for format "${format}".`,
    );
  }
  const length = bytes.byteLength / bytesPer;
  if (bytes.byteOffset % bytesPer === 0) {
    return makeNumberView(format, bytes.buffer, bytes.byteOffset, length);
  }
  const copy = bytes.slice();
  return makeNumberView(format, copy.buffer, 0, length);
}
