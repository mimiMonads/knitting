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
import {
  isSharedBuffer,
  type SharedBuffer,
  type SharedBufferSource,
  toSharedBufferRegion,
} from "../common/shared-buffer-region.ts";
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
    source: SharedBuffer,
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
const sharedBufferEncodeInto = (
  str: string,
  target: Uint8Array,
  textCompat?: SharedBufferTextCompat,
) => {
  if (typeof textEncode.encodeInto !== "function") {
    return fallbackEncodeInto(str, target);
  }
  if (textCompat?.encodeInto === true) {
    return textEncode.encodeInto(str, target);
  }
  if (textCompat?.encodeInto === false) return fallbackEncodeInto(str, target);
  try {
    return textEncode.encodeInto(str, target);
  } catch (error) {
    if (!isSharedBufferEncodeIntoError(error)) throw error;
    return fallbackEncodeInto(str, target);
  }
};
const sharedBufferDecode = (
  bytes: Uint8Array,
  textCompat?: SharedBufferTextCompat,
) => {
  if (textCompat?.decode === true) return textDecode.decode(bytes);
  if (textCompat?.decode === false) return fallbackDecode(bytes);
  try {
    return textDecode.decode(bytes);
  } catch (error) {
    if (!isSharedBufferDecodeError(error)) throw error;
    return fallbackDecode(bytes);
  }
};

export const createSharedDynamicBufferIO = ({
  sab,
  payloadConfig,
  textCompat,
}: {
  sab?: SharedBufferSource;
  payloadConfig?: PayloadBufferOptions;
  textCompat?: SharedBufferTextCompat;
}) => {
  const payloadRegion = sab === undefined
    ? undefined
    : toSharedBufferRegion(sab);
  const hasExplicitRegion = sab !== undefined && !isSharedBuffer(sab);
  const hasExternalArrayBuffer = payloadRegion?.sab instanceof ArrayBuffer &&
    !(payloadRegion.sab instanceof SharedArrayBuffer);
  const forceFixedRegion = hasExplicitRegion || hasExternalArrayBuffer;
  const regionByteLength = payloadRegion?.byteLength;
  const bufferCtor =
    (IS_BUN &&
        payloadRegion?.sab instanceof ArrayBuffer &&
        !(payloadRegion.sab instanceof SharedArrayBuffer))
      ? undefined
      : getBufferCtor();
  const resolvedPayload = resolvePayloadBufferOptions({
    sab: payloadRegion?.sab,
    options: !forceFixedRegion || regionByteLength === undefined
      ? payloadConfig
      : {
        ...payloadConfig,
        mode: "fixed",
        payloadInitialBytes: payloadConfig?.payloadInitialBytes ??
          regionByteLength,
        payloadMaxByteLength: payloadConfig?.payloadMaxByteLength ??
          regionByteLength,
      },
  });
  const canGrow = resolvedPayload.mode === "growable";
  let lockSAB: SharedBuffer = payloadRegion?.sab ??
    (
      canGrow
        ? createSharedArrayBuffer(
          resolvedPayload.payloadInitialBytes,
          resolvedPayload.payloadMaxByteLength,
        )
        : createSharedArrayBuffer(resolvedPayload.payloadInitialBytes)
    );
  let baseByteOffset = payloadRegion?.byteOffset ?? 0;
  let backingByteLength = payloadRegion?.byteLength ?? lockSAB.byteLength;

  let u8 = new Uint8Array(
    lockSAB,
    baseByteOffset + DYNAMIC_HEADER_BYTES,
    Math.max(0, backingByteLength - DYNAMIC_HEADER_BYTES),
  );
  const requireBufferView = bufferCtor
    ? (buffer: SharedBuffer, byteOffset: number) => {
      const view = bufferCtor.from(buffer, byteOffset + DYNAMIC_HEADER_BYTES);
      if (view.buffer !== buffer) {
        throw new Error("Buffer view does not alias shared buffer");
      }
      return view;
    }
    : undefined;
  let buf = requireBufferView?.(lockSAB, baseByteOffset);
  let f64 = new Float64Array(
    lockSAB,
    baseByteOffset + DYNAMIC_HEADER_BYTES,
    Math.max(0, backingByteLength - DYNAMIC_HEADER_BYTES) >>> 3,
  );

  const capacityBytes = () => backingByteLength - DYNAMIC_HEADER_BYTES;

  const adoptBuffer = () => {
    baseByteOffset = 0;
    backingByteLength = lockSAB.byteLength;
    u8 = new Uint8Array(
      lockSAB,
      baseByteOffset + DYNAMIC_HEADER_BYTES,
      backingByteLength - DYNAMIC_HEADER_BYTES,
    );
    buf = requireBufferView?.(lockSAB, baseByteOffset);
    f64 = new Float64Array(
      lockSAB,
      baseByteOffset + DYNAMIC_HEADER_BYTES,
      (backingByteLength - DYNAMIC_HEADER_BYTES) >>> 3,
    );
  };

  /**
   * Re-adopt the arena after the *other* endpoint grew it.
   *
   * Growth is in place and one-sided: the writer calls `grow` and its own views
   * are rebuilt, but every other endpoint on that buffer is still looking at the
   * length it started with, so a region placed past that length reads short.
   * Copied payloads mostly hide this -- their regions are released as they are
   * decoded, so the watermark stays low -- but a borrowed region is held for a
   * whole window and pushes straight past it.
   */
  const syncGrowth = () => {
    if (!canGrow) return;
    if (lockSAB.byteLength === backingByteLength) return;
    adoptBuffer();
  };

  const ensureCapacity = (neededBytes: number) => {
    if (capacityBytes() >= neededBytes) return true;
    if (!canGrow) return false;
    syncGrowth();
    if (capacityBytes() >= neededBytes) return true;

    try {
      if (!(lockSAB instanceof SharedArrayBuffer)) return false;
      lockSAB = growSharedArrayBuffer(
        lockSAB,
        alignUpto64(
          DYNAMIC_HEADER_BYTES + neededBytes + DYNAMIC_SAFE_PADDING_BYTES,
        ),
      );
    } catch {
      return false;
    }

    adoptBuffer();
    return true;
  };

  const readUtf8 = (start: number, end: number) => {
    if (!buf) {
      return sharedBufferDecode(u8.subarray(start, end), textCompat);
    }
    return buf!.toString("utf8", start, end);
  };

  const writeBinary = (src: Uint8Array, start = 0) => {
    const bytes = canonicalDynamicUint8Array(src);
    if (!ensureCapacity(start + bytes.byteLength)) {
      return -1;
    }
    u8.set(bytes, start);
    return bytes.byteLength;
  };
  const writeBuffer = (src: Uint8Array, start = 0) => {
    const bytes = src.byteLength;
    if (!ensureCapacity(start + bytes)) {
      return -1;
    }
    u8.set(src, start);
    return bytes;
  };
  const writeArrayBuffer = (src: ArrayBuffer, start = 0) => {
    const bytes = src.byteLength;
    if (!ensureCapacity(start + bytes)) {
      return -1;
    }
    u8.set(new Uint8Array(src), start);
    return bytes;
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

    const target = u8.subarray(start, start + reservedBytes);
    if (!buf) {
      const { read, written } = sharedBufferEncodeInto(str, target, textCompat);
      if (read !== str.length) return -1;
      return written;
    }

    const { read, written } = textEncode.encodeInto(str, target);
    if (read !== str.length) return -1;
    return written;
  };

  return {
    ensureCapacity,
    syncGrowth,
    capacityBytes,
    /** The buffer the dynamic views currently sit on; growth can replace it. */
    currentBuffer: () => lockSAB,
    /** Byte offset of region 0 inside that buffer; growth can move it. */
    regionBase: () => u8.byteOffset,
    readUtf8,
    writeBinary,
    writeBuffer,
    writeArrayBuffer,
    write8Binary,
    readBytesCopy,
    readBytesView,
    readBytesBufferCopy,
    readBufferCopy: readBytesBufferCopy,
    readBytesArrayBufferCopy,
    readArrayBufferCopy: readBytesArrayBufferCopy,
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

  // The static region is itself a Uint32Array, shared in-process with native
  // endianness. Fixed-shape numeric payloads (e.g. ProcessSharedBuffer
  // descriptors) can be written/read as raw words straight into the slot,
  // skipping the byte scratch + DataView + copy that the generic paths require.
  const baseU32 = new Uint32Array(
    buffer,
    baseByteOffset,
    (buffer.byteLength - baseByteOffset) >>> 2,
  );
  const slotU32Offsets = new Uint32Array(LockBound.slots);
  for (let i = 0; i < LockBound.slots; i++) {
    slotU32Offsets[i] = slotByteOffsets[i]! >>> 2;
  }

  const writeU32Words = (
    words: ArrayLike<number>,
    count: number,
    at: number,
  ): number => {
    const base = slotU32Offsets[at]!;
    for (let i = 0; i < count; i++) baseU32[base + i] = words[i]!;
    return count * u32Bytes;
  };
  const readU32Words = (
    out: Uint32Array,
    count: number,
    at: number,
  ): Uint32Array => {
    const base = slotU32Offsets[at]!;
    for (let i = 0; i < count; i++) out[i] = baseU32[base + i]!;
    return out;
  };

  const canWrite = (start: number, length: number) =>
    (start | 0) >= 0 && (start + length) <= writableBytes;

  const writeUtf8 = (str: string, at: number) => {
    const start = slotByteOffsets[at]!;
    const target = baseU8.subarray(start, start + writableBytes);
    if (!baseBuf) {
      const { read, written } = sharedBufferEncodeInto(
        str,
        target,
        textCompat,
      );
      if (read !== str.length) return -1;
      return written;
    }

    const { read, written } = textEncode.encodeInto(str, target);
    if (read !== str.length) return -1;
    return written;
  };

  const readUtf8 = (start: number, end: number, at: number) => {
    const slotStart = slotByteOffsets[at]!;
    if (!baseBuf) {
      return sharedBufferDecode(
        baseU8.subarray(slotStart + start, slotStart + end),
        textCompat,
      );
    }
    return baseBuf!.toString("utf8", slotStart + start, slotStart + end);
  };

  const writeBinary = (src: Uint8Array, at: number, start = 0) => {
    baseU8.set(src, slotByteOffsets[at]! + start);
    return src.byteLength;
  };
  const writeBuffer = (src: Uint8Array, at: number, start = 0) => {
    baseU8.set(src, slotByteOffsets[at]! + start);
    return src.byteLength;
  };
  const writeArrayBuffer = (src: ArrayBuffer, at: number, start = 0) => {
    const bytes = src.byteLength;
    baseU8.set(new Uint8Array(src), slotByteOffsets[at]! + start);
    return bytes;
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
    writeBuffer,
    writeArrayBuffer,
    writeExactUint8Array,
    writeUint8Array,
    writeU32Words,
    readU32Words,
    write8Binary,
    readBytesCopy,
    readBytesView,
    readBytesBufferCopy,
    readBufferCopy: readBytesBufferCopy,
    readUint8ArrayCopy,
    readUint8ArrayBufferCopy,
    readBytesArrayBufferCopy,
    readArrayBufferCopy: readBytesArrayBufferCopy,
    read8BytesFloatCopy,
    read8BytesFloatView,
    maxBytes: writableBytes,
  };
};
