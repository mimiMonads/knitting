import type { SharedBuffer, SharedBufferRegion } from "../common/shared-buffer-region.js";
export declare const BYTE_CARPET_ALIGN_BYTES = 64;
export declare const alignBytes: (value: number, alignment?: number) => number;
export declare const makeSharedBufferRegion: (sab: SharedBuffer, byteOffset: number, byteLength: number) => SharedBufferRegion;
export type ByteCarpetSlice = {
    name: string;
    byteOffset: number;
    byteLength: number;
    reservedByteLength: number;
};
export declare const createByteCarpet: ({ alignTo, startByteOffset, }?: {
    alignTo?: number;
    startByteOffset?: number;
}) => {
    slices: ByteCarpetSlice[];
    take: (name: string, byteLength: number, { alignTo: sliceAlignment, reserveByteLength, }?: {
        alignTo?: number;
        reserveByteLength?: number;
    }) => ByteCarpetSlice;
    byteLength: () => number;
    bind: (sab: SharedBuffer, slice: ByteCarpetSlice) => SharedBufferRegion;
};
export declare const getStridedSlotOffsetU32: ({ slotIndex, slotStrideU32, baseU32, extraU32, }: {
    slotIndex: number;
    slotStrideU32: number;
    baseU32?: number;
    extraU32?: number;
}) => number;
export declare const getStridedSlotByteOffset: ({ slotIndex, slotStrideU32, baseByteOffset, baseU32, extraU32, }: {
    slotIndex: number;
    slotStrideU32: number;
    baseByteOffset?: number;
    baseU32?: number;
    extraU32?: number;
}) => number;
export declare const getStridedRegionSpanBytes: ({ slotCount, slotStrideU32, slotLengthU32, baseU32, }: {
    slotCount: number;
    slotStrideU32: number;
    slotLengthU32: number;
    baseU32?: number;
}) => number;
export declare const getInterleavedSlotStrideU32: (slotStrideU32: number) => number;
export declare const getHeaderBlockByteLength: ({ slotCount, slotStrideU32, queues, alignTo, }: {
    slotCount: number;
    slotStrideU32: number;
    queues?: number;
    alignTo?: number;
}) => number;
export type HeaderLayoutMode = "split" | "interleaved";
export type QueueControlByteLayout = {
    headers: SharedBufferRegion;
    headerSlotStrideU32: number;
    lockSector: SharedBufferRegion;
    payloadSector: SharedBufferRegion;
};
export type LockControlCarpet = {
    controlSAB: SharedBuffer;
    signals: SharedBufferRegion;
    abortSignals: SharedBufferRegion;
    lock: QueueControlByteLayout;
    returnLock: QueueControlByteLayout;
    slices: readonly ByteCarpetSlice[];
};
export declare const createLockControlCarpet: ({ signalBytes, abortBytes, lockSectorBytes, headerSlotStrideU32, slotCount, headerLayout, alignTo, createBuffer, }: {
    signalBytes: number;
    abortBytes: number;
    lockSectorBytes: number;
    headerSlotStrideU32: number;
    slotCount: number;
    headerLayout?: HeaderLayoutMode;
    alignTo?: number;
    createBuffer?: (byteLength: number) => SharedBuffer;
}) => LockControlCarpet;
