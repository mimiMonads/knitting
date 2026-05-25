import { HEADER_SLOT_STRIDE_U32, HEADER_STATIC_PAYLOAD_U32, LockBound, } from "./lock.js";
import { getStridedSlotByteOffset } from "./byte-carpet.js";
import { IS_BUN, createSharedArrayBuffer, growSharedArrayBuffer, } from "../common/runtime.js";
import { resolvePayloadBufferOptions, } from "./payload-config.js";
import { isSharedBuffer, toSharedBufferRegion, } from "../common/shared-buffer-region.js";
const page = 1024 * 4;
const textEncode = new TextEncoder();
const textDecode = new TextDecoder();
const DYNAMIC_HEADER_BYTES = 64;
const DYNAMIC_SAFE_PADDING_BYTES = page;
const alignUpto64 = (n) => (n + (64 - 1)) & ~(64 - 1);
const isExactUint8Array = (src) => src.constructor === Uint8Array;
const canonicalDynamicUint8Array = (src) => isExactUint8Array(src)
    ? src
    : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
const isSharedBufferEncodeIntoError = (error) => error instanceof TypeError;
const isSharedBufferDecodeError = (error) => error instanceof TypeError;
const getBufferCtor = () => {
    const bufferCtor = globalThis.Buffer;
    if (typeof bufferCtor?.from !== "function" ||
        typeof bufferCtor?.allocUnsafe !== "function" ||
        typeof bufferCtor?.allocUnsafeSlow !== "function") {
        return undefined;
    }
    return bufferCtor;
};
const manualEncodeInto = (str, target) => {
    let read = 0;
    let written = 0;
    for (const char of str) {
        const encoded = textEncode.encode(char);
        if (written + encoded.byteLength > target.byteLength)
            break;
        target.set(encoded, written);
        written += encoded.byteLength;
        read += char.length;
    }
    return { read, written };
};
const fallbackEncodeInto = (str, target) => {
    const scratch = new Uint8Array(target.byteLength);
    const result = typeof textEncode.encodeInto === "function"
        ? textEncode.encodeInto(str, scratch)
        : manualEncodeInto(str, scratch);
    if (result.written > 0) {
        target.set(scratch.subarray(0, result.written), 0);
    }
    return result;
};
const fallbackDecode = (bytes) => textDecode.decode(bytes.slice());
const sharedBufferEncodeInto = (str, target, textCompat) => {
    if (typeof textEncode.encodeInto !== "function") {
        return fallbackEncodeInto(str, target);
    }
    if (textCompat?.encodeInto === true) {
        return textEncode.encodeInto(str, target);
    }
    if (textCompat?.encodeInto === false)
        return fallbackEncodeInto(str, target);
    try {
        return textEncode.encodeInto(str, target);
    }
    catch (error) {
        if (!isSharedBufferEncodeIntoError(error))
            throw error;
        return fallbackEncodeInto(str, target);
    }
};
const sharedBufferDecode = (bytes, textCompat) => {
    if (textCompat?.decode === true)
        return textDecode.decode(bytes);
    if (textCompat?.decode === false)
        return fallbackDecode(bytes);
    try {
        return textDecode.decode(bytes);
    }
    catch (error) {
        if (!isSharedBufferDecodeError(error))
            throw error;
        return fallbackDecode(bytes);
    }
};
export const createSharedDynamicBufferIO = ({ sab, payloadConfig, textCompat, }) => {
    const payloadRegion = sab === undefined
        ? undefined
        : toSharedBufferRegion(sab);
    const hasExplicitRegion = sab !== undefined && !isSharedBuffer(sab);
    const hasExternalArrayBuffer = payloadRegion?.sab instanceof ArrayBuffer &&
        !(payloadRegion.sab instanceof SharedArrayBuffer);
    const forceFixedRegion = hasExplicitRegion || hasExternalArrayBuffer;
    const regionByteLength = payloadRegion?.byteLength;
    const bufferCtor = (IS_BUN &&
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
    let lockSAB = payloadRegion?.sab ??
        (canGrow
            ? createSharedArrayBuffer(resolvedPayload.payloadInitialBytes, resolvedPayload.payloadMaxByteLength)
            : createSharedArrayBuffer(resolvedPayload.payloadInitialBytes));
    let baseByteOffset = payloadRegion?.byteOffset ?? 0;
    let backingByteLength = payloadRegion?.byteLength ?? lockSAB.byteLength;
    let u8 = new Uint8Array(lockSAB, baseByteOffset + DYNAMIC_HEADER_BYTES, Math.max(0, backingByteLength - DYNAMIC_HEADER_BYTES));
    const requireBufferView = bufferCtor
        ? (buffer, byteOffset) => {
            const view = bufferCtor.from(buffer, byteOffset + DYNAMIC_HEADER_BYTES);
            if (view.buffer !== buffer) {
                throw new Error("Buffer view does not alias shared buffer");
            }
            return view;
        }
        : undefined;
    let buf = requireBufferView?.(lockSAB, baseByteOffset);
    let f64 = new Float64Array(lockSAB, baseByteOffset + DYNAMIC_HEADER_BYTES, Math.max(0, backingByteLength - DYNAMIC_HEADER_BYTES) >>> 3);
    const capacityBytes = () => backingByteLength - DYNAMIC_HEADER_BYTES;
    const ensureCapacity = (neededBytes) => {
        if (capacityBytes() >= neededBytes)
            return true;
        if (!canGrow)
            return false;
        try {
            if (!(lockSAB instanceof SharedArrayBuffer))
                return false;
            lockSAB = growSharedArrayBuffer(lockSAB, alignUpto64(DYNAMIC_HEADER_BYTES + neededBytes + DYNAMIC_SAFE_PADDING_BYTES));
        }
        catch {
            return false;
        }
        baseByteOffset = 0;
        backingByteLength = lockSAB.byteLength;
        u8 = new Uint8Array(lockSAB, baseByteOffset + DYNAMIC_HEADER_BYTES, backingByteLength - DYNAMIC_HEADER_BYTES);
        buf = requireBufferView?.(lockSAB, baseByteOffset);
        f64 = new Float64Array(lockSAB, baseByteOffset + DYNAMIC_HEADER_BYTES, (backingByteLength - DYNAMIC_HEADER_BYTES) >>> 3);
        return true;
    };
    const readUtf8 = (start, end) => {
        if (!buf) {
            return sharedBufferDecode(u8.subarray(start, end), textCompat);
        }
        return buf.toString("utf8", start, end);
    };
    const writeBinary = (src, start = 0) => {
        const bytes = canonicalDynamicUint8Array(src);
        if (!ensureCapacity(start + bytes.byteLength)) {
            return -1;
        }
        u8.set(bytes, start);
        return bytes.byteLength;
    };
    const writeBuffer = (src, start = 0) => {
        const bytes = src.byteLength;
        if (!ensureCapacity(start + bytes)) {
            return -1;
        }
        u8.set(src, start);
        return bytes;
    };
    const writeArrayBuffer = (src, start = 0) => {
        const bytes = src.byteLength;
        if (!ensureCapacity(start + bytes)) {
            return -1;
        }
        u8.set(new Uint8Array(src), start);
        return bytes;
    };
    const write8Binary = (src, start = 0) => {
        const bytes = src.byteLength;
        if (!ensureCapacity(start + bytes)) {
            return -1;
        }
        f64.set(src, start >>> 3);
        return bytes;
    };
    const readBytesCopy = (start, end) => u8.slice(start, end);
    const readBytesView = (start, end) => u8.subarray(start, end);
    const readBytesBufferCopy = (start, end) => {
        if (!bufferCtor || !buf)
            return readBytesCopy(start, end);
        const length = Math.max(0, (end - start) | 0);
        const out = bufferCtor.allocUnsafe(length);
        if (length === 0)
            return out;
        buf.copy(out, 0, start, end);
        return out;
    };
    const readBytesArrayBufferCopy = (start, end) => {
        if (!bufferCtor || !buf) {
            const out = readBytesCopy(start, end);
            return out.buffer;
        }
        const length = Math.max(0, (end - start) | 0);
        if (length === 0)
            return new ArrayBuffer(0);
        const out = bufferCtor.allocUnsafeSlow(length);
        buf.copy(out, 0, start, end);
        return out.buffer;
    };
    const read8BytesFloatCopy = (start, end) => f64.slice(start >>> 3, end >>> 3);
    const read8BytesFloatView = (start, end) => f64.subarray(start >>> 3, end >>> 3);
    const writeUtf8 = (str, start, reservedBytes = str.length * 3) => {
        if (!ensureCapacity(start + reservedBytes)) {
            return -1;
        }
        const target = u8.subarray(start, start + reservedBytes);
        if (!buf) {
            const { read, written } = sharedBufferEncodeInto(str, target, textCompat);
            if (read !== str.length)
                return -1;
            return written;
        }
        const { read, written } = textEncode.encodeInto(str, target);
        if (read !== str.length)
            return -1;
        return written;
    };
    return {
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
export const createSharedStaticBufferIO = ({ headersBuffer, slotStrideU32, textCompat, }) => {
    const bufferCtor = getBufferCtor();
    const buffer = headersBuffer instanceof Uint32Array
        ? headersBuffer.buffer
        : headersBuffer;
    const baseByteOffset = headersBuffer instanceof Uint32Array
        ? headersBuffer.byteOffset
        : 0;
    const u32Bytes = Uint32Array.BYTES_PER_ELEMENT;
    const slotStride = slotStrideU32 ?? HEADER_SLOT_STRIDE_U32;
    const writableBytes = HEADER_STATIC_PAYLOAD_U32 * u32Bytes;
    const baseU8 = new Uint8Array(buffer, baseByteOffset);
    const baseBuf = bufferCtor?.from(buffer, baseByteOffset);
    const baseF64 = new Float64Array(buffer, baseByteOffset, (buffer.byteLength - baseByteOffset) >>> 3);
    const slotStartBytes = (at) => getStridedSlotByteOffset({
        slotIndex: at,
        slotStrideU32: slotStride,
        baseByteOffset,
        baseU32: LockBound.header,
    });
    const slotByteOffsets = new Uint32Array(LockBound.slots);
    for (let i = 0; i < LockBound.slots; i++) {
        slotByteOffsets[i] = slotStartBytes(i) - baseByteOffset;
    }
    const canWrite = (start, length) => (start | 0) >= 0 && (start + length) <= writableBytes;
    const writeUtf8 = (str, at) => {
        const start = slotByteOffsets[at];
        const target = baseU8.subarray(start, start + writableBytes);
        if (!baseBuf) {
            const { read, written } = sharedBufferEncodeInto(str, target, textCompat);
            if (read !== str.length)
                return -1;
            return written;
        }
        const { read, written } = textEncode.encodeInto(str, target);
        if (read !== str.length)
            return -1;
        return written;
    };
    const readUtf8 = (start, end, at) => {
        const slotStart = slotByteOffsets[at];
        if (!baseBuf) {
            return sharedBufferDecode(baseU8.subarray(slotStart + start, slotStart + end), textCompat);
        }
        return baseBuf.toString("utf8", slotStart + start, slotStart + end);
    };
    const writeBinary = (src, at, start = 0) => {
        baseU8.set(src, slotByteOffsets[at] + start);
        return src.byteLength;
    };
    const writeBuffer = (src, at, start = 0) => {
        baseU8.set(src, slotByteOffsets[at] + start);
        return src.byteLength;
    };
    const writeArrayBuffer = (src, at, start = 0) => {
        const bytes = src.byteLength;
        baseU8.set(new Uint8Array(src), slotByteOffsets[at] + start);
        return bytes;
    };
    const writeExactUint8Array = (src, at, start = 0) => {
        baseU8.set(src, slotByteOffsets[at] + start);
        return src.byteLength;
    };
    const writeUint8Array = (src, at, start = 0) => {
        if (!isExactUint8Array(src))
            return -1;
        return writeExactUint8Array(src, at, start);
    };
    const write8Binary = (src, at, start = 0) => {
        const bytes = src.byteLength;
        if (!canWrite(start, bytes))
            return -1;
        baseF64.set(src, (slotByteOffsets[at] + start) >>> 3);
        return bytes;
    };
    const readBytesCopy = (start, end, at) => baseU8.slice(slotByteOffsets[at] + start, slotByteOffsets[at] + end);
    const readBytesView = (start, end, at) => baseU8.subarray(slotByteOffsets[at] + start, slotByteOffsets[at] + end);
    const readBytesBufferCopy = (start, end, at) => {
        if (!bufferCtor || !baseBuf)
            return readBytesCopy(start, end, at);
        const length = end - start;
        const out = bufferCtor.allocUnsafe(length);
        const slotStart = slotByteOffsets[at];
        baseBuf.copy(out, 0, slotStart + start, slotStart + end);
        return out;
    };
    const readUint8ArrayBufferCopy = (start, end, at) => {
        if (!bufferCtor)
            return readBytesCopy(start, end, at);
        const bytes = readBytesBufferCopy(start, end, at);
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    const readUint8ArraySliceCopy = (start, end, at) => readBytesCopy(start, end, at);
    const readUint8ArrayCopy = IS_BUN
        ? readUint8ArraySliceCopy
        : readUint8ArrayBufferCopy;
    const readBytesArrayBufferCopy = (start, end, at) => {
        if (!bufferCtor || !baseBuf) {
            const out = readBytesCopy(start, end, at);
            return out.buffer;
        }
        const length = Math.max(0, (end - start) | 0);
        if (length === 0)
            return new ArrayBuffer(0);
        const out = bufferCtor.allocUnsafeSlow(length);
        const slotStart = slotByteOffsets[at];
        baseBuf.copy(out, 0, slotStart + start, slotStart + end);
        return out.buffer;
    };
    const read8BytesFloatCopy = (start, end, at) => baseF64.slice((slotByteOffsets[at] + start) >>> 3, (slotByteOffsets[at] + end) >>> 3);
    const read8BytesFloatView = (start, end, at) => baseF64.subarray((slotByteOffsets[at] + start) >>> 3, (slotByteOffsets[at] + end) >>> 3);
    return {
        writeUtf8,
        readUtf8,
        writeBinary,
        writeBuffer,
        writeArrayBuffer,
        writeExactUint8Array,
        writeUint8Array,
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
