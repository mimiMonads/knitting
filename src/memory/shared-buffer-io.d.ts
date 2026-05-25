import { type PayloadBufferOptions } from "./payload-config.js";
import { type SharedBuffer, type SharedBufferSource } from "../common/shared-buffer-region.js";
import type { SharedBufferTextCompat } from "../common/shared-buffer-text.js";
type BufferLike = Uint8Array & {
    copy: (target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number) => number;
    toString: (encoding?: string, start?: number, end?: number) => string;
};
export declare const createSharedDynamicBufferIO: ({ sab, payloadConfig, textCompat, }: {
    sab?: SharedBufferSource;
    payloadConfig?: PayloadBufferOptions;
    textCompat?: SharedBufferTextCompat;
}) => {
    readUtf8: (start: number, end: number) => string;
    writeBinary: (src: Uint8Array, start?: number) => number;
    writeBuffer: (src: Uint8Array, start?: number) => number;
    writeArrayBuffer: (src: ArrayBuffer, start?: number) => number;
    write8Binary: (src: Float64Array, start?: number) => number;
    readBytesCopy: (start: number, end: number) => Uint8Array<ArrayBuffer>;
    readBytesView: (start: number, end: number) => Uint8Array<SharedBuffer>;
    readBytesBufferCopy: (start: number, end: number) => Uint8Array<ArrayBuffer> | BufferLike;
    readBufferCopy: (start: number, end: number) => Uint8Array<ArrayBuffer> | BufferLike;
    readBytesArrayBufferCopy: (start: number, end: number) => ArrayBuffer;
    readArrayBufferCopy: (start: number, end: number) => ArrayBuffer;
    read8BytesFloatCopy: (start: number, end: number) => Float64Array<ArrayBuffer>;
    read8BytesFloatView: (start: number, end: number) => Float64Array<SharedBuffer>;
    writeUtf8: (str: string, start: number, reservedBytes?: number) => number;
};
export declare const createSharedStaticBufferIO: ({ headersBuffer, slotStrideU32, textCompat, }: {
    headersBuffer: SharedArrayBuffer | Uint32Array;
    slotStrideU32?: number;
    textCompat?: SharedBufferTextCompat;
}) => {
    writeUtf8: (str: string, at: number) => number;
    readUtf8: (start: number, end: number, at: number) => string;
    writeBinary: (src: Uint8Array, at: number, start?: number) => number;
    writeBuffer: (src: Uint8Array, at: number, start?: number) => number;
    writeArrayBuffer: (src: ArrayBuffer, at: number, start?: number) => number;
    writeExactUint8Array: (src: Uint8Array, at: number, start?: number) => number;
    writeUint8Array: (src: Uint8Array, at: number, start?: number) => number;
    write8Binary: (src: Float64Array, at: number, start?: number) => number;
    readBytesCopy: (start: number, end: number, at: number) => Uint8Array<ArrayBuffer>;
    readBytesView: (start: number, end: number, at: number) => Uint8Array<SharedArrayBuffer>;
    readBytesBufferCopy: (start: number, end: number, at: number) => Uint8Array<ArrayBuffer> | BufferLike;
    readBufferCopy: (start: number, end: number, at: number) => Uint8Array<ArrayBuffer> | BufferLike;
    readUint8ArrayCopy: (start: number, end: number, at: number) => Uint8Array<ArrayBufferLike>;
    readUint8ArrayBufferCopy: (start: number, end: number, at: number) => Uint8Array<ArrayBufferLike>;
    readBytesArrayBufferCopy: (start: number, end: number, at: number) => ArrayBuffer;
    readArrayBufferCopy: (start: number, end: number, at: number) => ArrayBuffer;
    read8BytesFloatCopy: (start: number, end: number, at: number) => Float64Array<ArrayBuffer>;
    read8BytesFloatView: (start: number, end: number, at: number) => Float64Array<SharedArrayBuffer>;
    maxBytes: number;
};
export {};
