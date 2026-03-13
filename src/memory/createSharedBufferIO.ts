import { Buffer as NodeBuffer } from "node:buffer";
import {
  HEADER_SLOT_STRIDE_U32,
  HEADER_STATIC_PAYLOAD_U32,
  LockBound,
} from "./lock.ts";
import {
  createSharedArrayBuffer,
  growSharedArrayBuffer,
  IS_NODE,
} from "../common/runtime.ts";
import {
  type PayloadBufferOptions,
  resolvePayloadBufferOptions,
} from "./payload-config.ts";

const page = 1024 * 4;
const textEncode = new TextEncoder();
const DYNAMIC_HEADER_BYTES = 64;
const DYNAMIC_SAFE_PADDING_BYTES = page;
const NODE_BUFFER_COPY_MIN_BYTES = 2048;

const alignUpto64 = (n: number) => (n + (64 - 1)) & ~(64 - 1);
const canonicalDynamicUint8Array = (src: Uint8Array) =>
  src.constructor === Uint8Array
    ? src
    : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
const writeNodeBuffer = (
  target: InstanceType<typeof NodeBuffer>,
  src: Uint8Array,
  start: number,
) => {
  if (!IS_NODE || src.byteLength < NODE_BUFFER_COPY_MIN_BYTES) {
    return false;
  }

  NodeBuffer.from(src.buffer, src.byteOffset, src.byteLength).copy(
    target,
    start,
    0,
    src.byteLength,
  );
  return true;
};

export const createSharedDynamicBufferIO = ({
  sab,
  payloadConfig,
}: {
  sab?: SharedArrayBuffer;
  payloadConfig?: PayloadBufferOptions;
}) => {
  const resolvedPayload = resolvePayloadBufferOptions({
    sab,
    options: payloadConfig,
  });
  const canGrow = resolvedPayload.mode === "growable";
  let lockSAB = sab ??
    (
      canGrow
        ? createSharedArrayBuffer(
          resolvedPayload.payloadInitialBytes,
          resolvedPayload.payloadMaxByteLength,
        )
        : createSharedArrayBuffer(resolvedPayload.payloadInitialBytes)
    );

  let u8 = new Uint8Array(lockSAB, DYNAMIC_HEADER_BYTES);
  const requireBufferView = (buffer: SharedArrayBuffer) => {
    const view = NodeBuffer.from(buffer, DYNAMIC_HEADER_BYTES);
    if (view.buffer !== buffer) {
      throw new Error("Buffer view does not alias SharedArrayBuffer");
    }
    return view;
  };
  let buf = requireBufferView(lockSAB);
  let i32 = new Int32Array(lockSAB, DYNAMIC_HEADER_BYTES);
  let f64 = new Float64Array(lockSAB, DYNAMIC_HEADER_BYTES);

  const capacityBytes = () => lockSAB.byteLength - DYNAMIC_HEADER_BYTES;

  const ensureCapacity = (neededBytes: number) => {
    if (capacityBytes() >= neededBytes) return true;
    if (!canGrow) return false;

    try {
      lockSAB = growSharedArrayBuffer(
        lockSAB,
        alignUpto64(
          DYNAMIC_HEADER_BYTES + neededBytes + DYNAMIC_SAFE_PADDING_BYTES,
        ),
      );
    } catch {
      return false;
    }

    u8 = new Uint8Array(
      lockSAB,
      DYNAMIC_HEADER_BYTES,
      lockSAB.byteLength - DYNAMIC_HEADER_BYTES,
    );
    buf = requireBufferView(lockSAB);
    i32 = new Int32Array(
      lockSAB,
      DYNAMIC_HEADER_BYTES,
      (lockSAB.byteLength - DYNAMIC_HEADER_BYTES) >>> 2,
    );
    f64 = new Float64Array(
      lockSAB,
      DYNAMIC_HEADER_BYTES,
      (lockSAB.byteLength - DYNAMIC_HEADER_BYTES) >>> 3,
    );
    return true;
  };

  const readUtf8 = (start: number, end: number) => {
    return buf!.toString("utf8", start, end);
  };

  const writeBinary = (src: Uint8Array, start = 0) => {
    const bytes = canonicalDynamicUint8Array(src);
    if (!ensureCapacity(start + bytes.byteLength)) {
      return -1;
    }
    if (!writeNodeBuffer(buf, bytes, start)) {
      u8.set(bytes, start);
    }
    return bytes.byteLength;
  };

  const write8Binary = (src: Float64Array, start = 0) => {
    const bytes = src.byteLength;
    if (!ensureCapacity(start + bytes)) {
      return -1;
    }
    f64.set(src, start >>> 3);
    return bytes;
  };

  const readBytesCopy = (start: number, end: number) => u8.slice(start, end);
  const readBytesView = (start: number, end: number) => u8.subarray(start, end);
  const readBytesBufferCopy = (start: number, end: number) => {
    const length = Math.max(0, (end - start) | 0);
    const out = NodeBuffer.allocUnsafe(length);
    if (length === 0) return out;
    buf.copy(out, 0, start, end);
    return out;
  };
  const readBytesArrayBufferCopy = (
    start: number,
    end: number,
  ): ArrayBuffer => {
    const length = Math.max(0, (end - start) | 0);
    if (length === 0) return new ArrayBuffer(0);
    // allocUnsafeSlow gives a dedicated ArrayBuffer (not pool slab), so
    // returning .buffer is safe and avoids the zero-init cost of new Uint8Array.
    const out = NodeBuffer.allocUnsafeSlow(length);
    buf.copy(out, 0, start, end);
    return out.buffer;
  };

  const read8BytesFloatCopy = (start: number, end: number) =>
    f64.slice(start >>> 3, end >>> 3);
  const read4BytesIntCopy = (start: number, end: number) =>
    i32.slice(start >>> 2, end >>> 2);
  const read8BytesFloatView = (start: number, end: number) =>
    f64.subarray(start >>> 3, end >>> 3);

  const writeUtf8 = (
    str: string,
    start: number,
    reservedBytes = str.length * 3,
  ) => {
    if (!ensureCapacity(start + reservedBytes)) {
      return -1;
    }

    const { read, written } = textEncode.encodeInto(
      str,
      u8.subarray(start, start + reservedBytes),
    );
    if (read !== str.length) return -1;
    return written;
  };

  return {
    readUtf8,
    writeBinary,
    write8Binary,
    readBytesCopy,
    readBytesView,
    readBytesBufferCopy,
    readBytesArrayBufferCopy,
    read4BytesIntCopy,
    read8BytesFloatCopy,
    read8BytesFloatView,
    writeUtf8,
  };
};

// it has to be convert it to 8
export const createSharedStaticBufferIO = ({
  headersBuffer,
}: {
  headersBuffer: SharedArrayBuffer | Uint32Array;
}) => {
  const buffer = headersBuffer instanceof Uint32Array
    ? headersBuffer.buffer as SharedArrayBuffer
    : headersBuffer;
  const baseByteOffset = headersBuffer instanceof Uint32Array
    ? headersBuffer.byteOffset
    : 0;
  const u32Bytes = Uint32Array.BYTES_PER_ELEMENT;
  const slotStride = HEADER_SLOT_STRIDE_U32;
  const writableBytes = HEADER_STATIC_PAYLOAD_U32 * u32Bytes;

  // Static payload starts at the aligned slot base; the task header starts on
  // its own cache line after the writable payload region.
  const slotOffset = (at: number) => (at * slotStride) + LockBound.header;
  const slotStartBytes = (at: number) =>
    baseByteOffset + (slotOffset(at) * u32Bytes);

  const arrU8Sec = Array.from({
    length: LockBound.slots,
  }, (_, i) => new Uint8Array(buffer, slotStartBytes(i), writableBytes));

  const arrBuffSec = Array.from(
    { length: LockBound.slots },
    (_, i) => NodeBuffer.from(buffer, slotStartBytes(i), writableBytes),
  );

  const arrF64Sec = Array.from({
    length: LockBound.slots,
  }, (_, i) =>
    new Float64Array(
      buffer,
      slotStartBytes(i),
      writableBytes >>> 3,
    ));
  const arrI32Sec = Array.from({
    length: LockBound.slots,
  }, (_, i) =>
    new Int32Array(
      buffer,
      slotStartBytes(i),
      writableBytes >>> 2,
    ));

  const canWrite = (start: number, length: number) =>
    (start | 0) >= 0 && (start + length) <= writableBytes;

  const writeUtf8 = (str: string, at: number) => {
    const { read, written } = textEncode.encodeInto(str, arrU8Sec[at]);
    if (read !== str.length) return -1;

    return written;
  };

  const readUtf8 = (start: number, end: number, at: number) => {
    return arrBuffSec[at]!.toString("utf8", start, end);
  };

  const writeBinary = (src: Uint8Array, at: number, start = 0) => {
    const bytes = canonicalDynamicUint8Array(src);
    if (!canWrite(start, bytes.byteLength)) return -1;

    if (!writeNodeBuffer(arrBuffSec[at]!, bytes, start)) {
      arrU8Sec[at].set(bytes, start);
    }
    return bytes.byteLength;
  };

  const write8Binary = (src: Float64Array, at: number, start = 0) => {
    const bytes = src.byteLength;
    if (!canWrite(start, bytes)) return -1;
    arrF64Sec[at].set(src, start >>> 3);
    return bytes;
  };

  const readBytesCopy = (start: number, end: number, at: number) =>
    arrU8Sec[at].slice(start, end);
  const readBytesView = (start: number, end: number, at: number) =>
    arrU8Sec[at].subarray(start, end);
  const readBytesBufferCopy = (start: number, end: number, at: number) => {
    const length = Math.max(0, (end - start) | 0);
    const out = NodeBuffer.allocUnsafe(length);
    if (length === 0) return out;
    arrBuffSec[at]!.copy(out, 0, start, end);
    return out;
  };
  const readBytesArrayBufferCopy = (
    start: number,
    end: number,
    at: number,
  ): ArrayBuffer => {
    const length = Math.max(0, (end - start) | 0);
    if (length === 0) return new ArrayBuffer(0);
    const out = NodeBuffer.allocUnsafeSlow(length);
    arrBuffSec[at]!.copy(out, 0, start, end);
    return out.buffer;
  };

  const read8BytesFloatCopy = (start: number, end: number, at: number) =>
    arrF64Sec[at].slice(start >>> 3, end >>> 3);
  const read4BytesIntCopy = (start: number, end: number, at: number) =>
    arrI32Sec[at].slice(start >>> 2, end >>> 2);
  const read8BytesFloatView = (start: number, end: number, at: number) =>
    arrF64Sec[at].subarray(start >>> 3, end >>> 3);

  return {
    writeUtf8,
    readUtf8,
    writeBinary,
    write8Binary,
    readBytesCopy,
    readBytesView,
    readBytesBufferCopy,
    readBytesArrayBufferCopy,
    read4BytesIntCopy,
    read8BytesFloatCopy,
    read8BytesFloatView,
    maxBytes: writableBytes,
  };
};
