import {
  HEADER_SLOT_STRIDE_U32,
  HEADER_STATIC_PAYLOAD_U32,
  LockBound,
} from "./lock.ts";
import { getStridedSlotByteOffset } from "./byte-carpet.ts";
import {
  IS_BUN,
  createSharedArrayBuffer,
  growSharedArrayBuffer,
} from "../common/runtime.ts";
import {
  type PayloadBufferOptions,
  resolvePayloadBufferOptions,
} from "./payload-config.ts";
import type { SharedBufferTextCompat } from "../common/shared-buffer-text.ts";
const page = 1024 * 4;
const textEncode = new TextEncoder();
const textDecode = new TextDecoder();
const DYNAMIC_HEADER_BYTES = 64;
const DYNAMIC_SAFE_PADDING_BYTES = page;

const alignUpto64 = (n: number) => (n + (64 - 1)) & ~(64 - 1);
const isExactUint8Array = (src: Uint8Array) => src.constructor === Uint8Array;
const canonicalDynamicUint8Array = (src: Uint8Array) =>
  isExactUint8Array(src)
    ? src
    : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
const isSharedBufferEncodeIntoError = (error: unknown) =>
  error instanceof TypeError;
const isSharedBufferDecodeError = (error: unknown) =>
  error instanceof TypeError;
type BufferLike = Uint8Array & {
  copy: (
    target: Uint8Array,
    targetStart?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ) => number;
  toString: (encoding?: string, start?: number, end?: number) => string;
};
type BufferCtorLike = {
  from: (
    source: SharedArrayBuffer | ArrayBuffer,
    byteOffset?: number,
    length?: number,
  ) => BufferLike;
  allocUnsafe: (size: number) => BufferLike;
  allocUnsafeSlow: (size: number) => BufferLike;
};
const getBufferCtor = (): BufferCtorLike | undefined => {
  const bufferCtor = (globalThis as typeof globalThis & {
    Buffer?: {
      from?: (
        source: SharedArrayBuffer | ArrayBuffer,
        byteOffset?: number,
        length?: number,
      ) => BufferLike;
      allocUnsafe?: (size: number) => BufferLike;
      allocUnsafeSlow?: (size: number) => BufferLike;
    };
  }).Buffer;
  if (
    typeof bufferCtor?.from !== "function" ||
    typeof bufferCtor?.allocUnsafe !== "function" ||
    typeof bufferCtor?.allocUnsafeSlow !== "function"
  ) {
    return undefined;
  }
  return bufferCtor as BufferCtorLike;
};
const manualEncodeInto = (str: string, target: Uint8Array) => {
  let read = 0;
  let written = 0;

  for (const char of str) {
    const encoded = textEncode.encode(char);
    if (written + encoded.byteLength > target.byteLength) break;
    target.set(encoded, written);
    written += encoded.byteLength;
    read += char.length;
  }

  return { read, written };
};
const fallbackEncodeInto = (str: string, target: Uint8Array) => {
  const scratch = new Uint8Array(target.byteLength);
  const result = typeof textEncode.encodeInto === "function"
    ? textEncode.encodeInto(str, scratch)
    : manualEncodeInto(str, scratch);
  if (result.written > 0) {
    target.set(scratch.subarray(0, result.written), 0);
  }
  return result;
};
const fallbackDecode = (bytes: Uint8Array) => textDecode.decode(bytes.slice());
const createEncodeIntoCompat = (textCompat?: SharedBufferTextCompat) => {
  if (typeof textEncode.encodeInto !== "function") return fallbackEncodeInto;
  if (textCompat?.encodeInto === true) {
    return (str: string, target: Uint8Array) => textEncode.encodeInto(str, target);
  }
  if (textCompat?.encodeInto === false) return fallbackEncodeInto;

  let encodeInto = (str: string, target: Uint8Array) => {
    try {
      return textEncode.encodeInto(str, target);
    } catch (error) {
      if (!isSharedBufferEncodeIntoError(error)) {
        throw error;
      }
      encodeInto = fallbackEncodeInto;
      return encodeInto(str, target);
    }
  };

  return (str: string, target: Uint8Array) => encodeInto(str, target);
};
const createDecodeCompat = (textCompat?: SharedBufferTextCompat) => {
  if (textCompat?.decode === true) {
    return (bytes: Uint8Array) => textDecode.decode(bytes);
  }
  if (textCompat?.decode === false) return fallbackDecode;

  let decode = (bytes: Uint8Array) => {
    try {
      return textDecode.decode(bytes);
    } catch (error) {
      if (!isSharedBufferDecodeError(error)) {
        throw error;
      }
      decode = fallbackDecode;
      return decode(bytes);
    }
  };

  return (bytes: Uint8Array) => decode(bytes);
};
const createTextCompatIO = (textCompat?: SharedBufferTextCompat) => {
  return {
    encodeIntoCompat: createEncodeIntoCompat(textCompat),
    decodeCompat: createDecodeCompat(textCompat),
  };
};

export const createSharedDynamicBufferIO = ({
  sab,
  payloadConfig,
  textCompat,
}: {
  sab?: SharedArrayBuffer;
  payloadConfig?: PayloadBufferOptions;
  textCompat?: SharedBufferTextCompat;
}) => {
  const { encodeIntoCompat, decodeCompat } = createTextCompatIO(textCompat);
  const bufferCtor = getBufferCtor();
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
  const requireBufferView = bufferCtor
    ? (buffer: SharedArrayBuffer) => {
      const view = bufferCtor.from(buffer, DYNAMIC_HEADER_BYTES);
      if (view.buffer !== buffer) {
        throw new Error("Buffer view does not alias SharedArrayBuffer");
      }
      return view;
    }
    : undefined;
  let buf = requireBufferView?.(lockSAB);
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
    buf = requireBufferView?.(lockSAB);
    f64 = new Float64Array(
      lockSAB,
      DYNAMIC_HEADER_BYTES,
      (lockSAB.byteLength - DYNAMIC_HEADER_BYTES) >>> 3,
    );
    return true;
  };

  const readUtf8 = (start: number, end: number) => {
    if (buf) return buf.toString("utf8", start, end);
    return decodeCompat(u8.subarray(start, end));
  };

  const writeBinary = (src: Uint8Array, start = 0) => {
    const bytes = canonicalDynamicUint8Array(src);
    if (!ensureCapacity(start + bytes.byteLength)) {
      return -1;
    }
    u8.set(bytes, start);
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
    if (!bufferCtor || !buf) return readBytesCopy(start, end);
    const length = Math.max(0, (end - start) | 0);
    const out = bufferCtor.allocUnsafe(length);
    if (length === 0) return out;
    buf.copy(out, 0, start, end);
    return out;
  };
  const readBytesArrayBufferCopy = (
    start: number,
    end: number,
  ): ArrayBuffer => {
    if (!bufferCtor || !buf) {
      const out = readBytesCopy(start, end);
      return out.buffer as ArrayBuffer;
    }
    const length = Math.max(0, (end - start) | 0);
    if (length === 0) return new ArrayBuffer(0);
    const out = bufferCtor.allocUnsafeSlow(length);
    buf.copy(out, 0, start, end);
    return out.buffer as ArrayBuffer;
  };

  const read8BytesFloatCopy = (start: number, end: number) =>
    f64.slice(start >>> 3, end >>> 3);
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

    const { read, written } = encodeIntoCompat(
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
    read8BytesFloatCopy,
    read8BytesFloatView,
    writeUtf8,
  };
};

// it has to be convert it to 8
export const createSharedStaticBufferIO = ({
  headersBuffer,
  slotStrideU32,
  textCompat,
}: {
  headersBuffer: SharedArrayBuffer | Uint32Array;
  slotStrideU32?: number;
  textCompat?: SharedBufferTextCompat;
}) => {
  const { encodeIntoCompat, decodeCompat } = createTextCompatIO(textCompat);
  const bufferCtor = getBufferCtor();
  const buffer = headersBuffer instanceof Uint32Array
    ? headersBuffer.buffer as SharedArrayBuffer
    : headersBuffer;
  const baseByteOffset = headersBuffer instanceof Uint32Array
    ? headersBuffer.byteOffset
    : 0;
  const u32Bytes = Uint32Array.BYTES_PER_ELEMENT;
  const slotStride = slotStrideU32 ?? HEADER_SLOT_STRIDE_U32;
  const writableBytes = HEADER_STATIC_PAYLOAD_U32 * u32Bytes;
  const baseU8 = new Uint8Array(buffer, baseByteOffset);
  const baseBuf = bufferCtor?.from(buffer, baseByteOffset);
  const baseF64 = new Float64Array(
    buffer,
    baseByteOffset,
    (buffer.byteLength - baseByteOffset) >>> 3,
  );

  const slotStartBytes = (at: number) =>
    getStridedSlotByteOffset({
      slotIndex: at,
      slotStrideU32: slotStride,
      baseByteOffset,
      baseU32: LockBound.header,
    });

  const slotByteOffsets = new Uint32Array(LockBound.slots);
  for (let i = 0; i < LockBound.slots; i++) {
    slotByteOffsets[i] = slotStartBytes(i) - baseByteOffset;
  }

  const canWrite = (start: number, length: number) =>
    (start | 0) >= 0 && (start + length) <= writableBytes;

  const writeUtf8 = (str: string, at: number) => {
    const start = slotByteOffsets[at]!;
    const { read, written } = encodeIntoCompat(
      str,
      baseU8.subarray(start, start + writableBytes),
    );
    if (read !== str.length) return -1;

    return written;
  };

  const readUtf8 = (start: number, end: number, at: number) => {
    const slotStart = slotByteOffsets[at]!;
    if (baseBuf) return baseBuf.toString("utf8", slotStart + start, slotStart + end);
    return decodeCompat(baseU8.subarray(slotStart + start, slotStart + end));
  };

  const writeBinary = (src: Uint8Array, at: number, start = 0) => {
    baseU8.set(src, slotByteOffsets[at]! + start);
    return src.byteLength;
  };
  const writeExactUint8Array = (src: Uint8Array, at: number, start = 0) => {
    baseU8.set(src, slotByteOffsets[at]! + start);
    return src.byteLength;
  };
  const writeUint8Array = (src: Uint8Array, at: number, start = 0) => {
    if (!isExactUint8Array(src)) return -1;
    return writeExactUint8Array(src, at, start);
  };

  const write8Binary = (src: Float64Array, at: number, start = 0) => {
    const bytes = src.byteLength;
    if (!canWrite(start, bytes)) return -1;
    baseF64.set(src, (slotByteOffsets[at]! + start) >>> 3);
    return bytes;
  };

  const readBytesCopy = (start: number, end: number, at: number) =>
    baseU8.slice(slotByteOffsets[at]! + start, slotByteOffsets[at]! + end);
  const readBytesView = (start: number, end: number, at: number) =>
    baseU8.subarray(slotByteOffsets[at]! + start, slotByteOffsets[at]! + end);
  const readBytesBufferCopy = (start: number, end: number, at: number) => {
    if (!bufferCtor || !baseBuf) return readBytesCopy(start, end, at);
    const length = end - start;
    const out = bufferCtor.allocUnsafe(length);
    const slotStart = slotByteOffsets[at]!;
    baseBuf.copy(out, 0, slotStart + start, slotStart + end);
    return out;
  };
  const readUint8ArrayBufferCopy = (
    start: number,
    end: number,
    at: number,
  ) => {
    if (!bufferCtor) return readBytesCopy(start, end, at);
    const bytes = readBytesBufferCopy(start, end, at);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const readUint8ArraySliceCopy = (
    start: number,
    end: number,
    at: number,
  ) => readBytesCopy(start, end, at);
  const readUint8ArrayCopy = IS_BUN
    ? readUint8ArraySliceCopy
    : readUint8ArrayBufferCopy;

  const readBytesArrayBufferCopy = (
    start: number,
    end: number,
    at: number,
  ): ArrayBuffer => {
    if (!bufferCtor || !baseBuf) {
      const out = readBytesCopy(start, end, at);
      return out.buffer as ArrayBuffer;
    }
    const length = Math.max(0, (end - start) | 0);
    if (length === 0) return new ArrayBuffer(0);
    const out = bufferCtor.allocUnsafeSlow(length);
    const slotStart = slotByteOffsets[at]!;
    baseBuf.copy(out, 0, slotStart + start, slotStart + end);
    return out.buffer as ArrayBuffer;
  };

  const read8BytesFloatCopy = (start: number, end: number, at: number) =>
    baseF64.slice(
      (slotByteOffsets[at]! + start) >>> 3,
      (slotByteOffsets[at]! + end) >>> 3,
    );
  const read8BytesFloatView = (start: number, end: number, at: number) =>
    baseF64.subarray(
      (slotByteOffsets[at]! + start) >>> 3,
      (slotByteOffsets[at]! + end) >>> 3,
    );

  return {
    writeUtf8,
    readUtf8,
    writeBinary,
    writeExactUint8Array,
    writeUint8Array,
    write8Binary,
    readBytesCopy,
    readBytesView,
    readBytesBufferCopy,
    readUint8ArrayCopy,
    readUint8ArrayBufferCopy,
    readBytesArrayBufferCopy,
    read8BytesFloatCopy,
    read8BytesFloatView,
    maxBytes: writableBytes,
  };
};
