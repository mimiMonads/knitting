export const BYTE_CARPET_ALIGN_BYTES = 64;
const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const toNonNegativeInteger = (value, label) => {
    if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative integer`);
    }
    return value;
};
export const alignBytes = (value, alignment = BYTE_CARPET_ALIGN_BYTES) => {
    const safeValue = toNonNegativeInteger(value, "value");
    const safeAlignment = toNonNegativeInteger(alignment, "alignment");
    if (safeAlignment === 0) {
        throw new RangeError("alignment must be greater than zero");
    }
    return Math.ceil(safeValue / safeAlignment) * safeAlignment;
};
export const makeSharedBufferRegion = (sab, byteOffset, byteLength) => ({
    sab,
    byteOffset: toNonNegativeInteger(byteOffset, "byteOffset"),
    byteLength: toNonNegativeInteger(byteLength, "byteLength"),
});
export const createByteCarpet = ({ alignTo = BYTE_CARPET_ALIGN_BYTES, startByteOffset = 0, } = {}) => {
    const defaultAlignment = toNonNegativeInteger(alignTo, "alignTo");
    if (defaultAlignment === 0) {
        throw new RangeError("alignTo must be greater than zero");
    }
    let cursor = toNonNegativeInteger(startByteOffset, "startByteOffset");
    const slices = [];
    const take = (name, byteLength, { alignTo: sliceAlignment = defaultAlignment, reserveByteLength, } = {}) => {
        const logicalByteLength = toNonNegativeInteger(byteLength, `${name} byteLength`);
        const safeSliceAlignment = toNonNegativeInteger(sliceAlignment, `${name} alignTo`);
        if (safeSliceAlignment === 0) {
            throw new RangeError(`${name} alignTo must be greater than zero`);
        }
        const reserved = reserveByteLength == null
            ? alignBytes(logicalByteLength, safeSliceAlignment)
            : toNonNegativeInteger(reserveByteLength, `${name} reserveByteLength`);
        if (reserved < logicalByteLength) {
            throw new RangeError(`${name} reserveByteLength must cover byteLength`);
        }
        const byteOffset = alignBytes(cursor, safeSliceAlignment);
        const slice = {
            name,
            byteOffset,
            byteLength: logicalByteLength,
            reservedByteLength: reserved,
        };
        slices.push(slice);
        cursor = byteOffset + reserved;
        return slice;
    };
    return {
        slices,
        take,
        byteLength: () => cursor,
        bind: (sab, slice) => makeSharedBufferRegion(sab, slice.byteOffset, slice.byteLength),
    };
};
export const getStridedSlotOffsetU32 = ({ slotIndex, slotStrideU32, baseU32 = 0, extraU32 = 0, }) => (slotIndex * slotStrideU32) + baseU32 + extraU32;
export const getStridedSlotByteOffset = ({ slotIndex, slotStrideU32, baseByteOffset = 0, baseU32 = 0, extraU32 = 0, }) => baseByteOffset +
    (getStridedSlotOffsetU32({
        slotIndex,
        slotStrideU32,
        baseU32,
        extraU32,
    }) * U32_BYTES);
export const getStridedRegionSpanBytes = ({ slotCount, slotStrideU32, slotLengthU32, baseU32 = 0, }) => {
    const safeSlotCount = toNonNegativeInteger(slotCount, "slotCount");
    if (safeSlotCount === 0)
        return 0;
    return (getStridedSlotOffsetU32({
        slotIndex: safeSlotCount - 1,
        slotStrideU32,
        baseU32,
    }) + slotLengthU32) * U32_BYTES;
};
export const getInterleavedSlotStrideU32 = (slotStrideU32) => slotStrideU32 * 2;
export const getHeaderBlockByteLength = ({ slotCount, slotStrideU32, queues = 1, alignTo = BYTE_CARPET_ALIGN_BYTES, }) => alignBytes(slotCount * slotStrideU32 * U32_BYTES * queues, alignTo);
const createInterleavedHeaderPair = ({ sab, byteOffset, slotCount, slotStrideU32, }) => {
    const headerSlotStrideU32 = getInterleavedSlotStrideU32(slotStrideU32);
    const slotBytes = slotStrideU32 * U32_BYTES;
    const spanBytes = getStridedRegionSpanBytes({
        slotCount,
        slotStrideU32: headerSlotStrideU32,
        slotLengthU32: slotStrideU32,
    });
    return {
        headerSlotStrideU32,
        requestHeaders: makeSharedBufferRegion(sab, byteOffset, spanBytes),
        returnHeaders: makeSharedBufferRegion(sab, byteOffset + slotBytes, spanBytes),
    };
};
export const createLockControlCarpet = ({ signalBytes, abortBytes, lockSectorBytes, headerSlotStrideU32, slotCount, headerLayout = "interleaved", alignTo = BYTE_CARPET_ALIGN_BYTES, createBuffer = (byteLength) => new SharedArrayBuffer(byteLength), }) => {
    const carpet = createByteCarpet({ alignTo });
    const signalsSlice = carpet.take("signals", signalBytes);
    const requestLockSlice = carpet.take("requestLockSector", lockSectorBytes);
    const returnLockSlice = carpet.take("returnLockSector", lockSectorBytes);
    let requestHeadersSlice;
    let returnHeadersSlice;
    let interleavedHeadersSlice;
    if (headerLayout === "interleaved") {
        interleavedHeadersSlice = carpet.take("interleavedHeaders", getHeaderBlockByteLength({
            slotCount,
            slotStrideU32: headerSlotStrideU32,
            queues: 2,
            alignTo,
        }));
    }
    else {
        requestHeadersSlice = carpet.take("requestHeaders", getHeaderBlockByteLength({
            slotCount,
            slotStrideU32: headerSlotStrideU32,
            alignTo,
        }));
        returnHeadersSlice = carpet.take("returnHeaders", getHeaderBlockByteLength({
            slotCount,
            slotStrideU32: headerSlotStrideU32,
            alignTo,
        }));
    }
    const abortSignalsSlice = carpet.take("abortSignals", abortBytes);
    const controlSAB = createBuffer(carpet.byteLength());
    const signals = carpet.bind(controlSAB, signalsSlice);
    const abortSignals = carpet.bind(controlSAB, abortSignalsSlice);
    const requestLockSector = carpet.bind(controlSAB, requestLockSlice);
    const returnLockSector = carpet.bind(controlSAB, returnLockSlice);
    const headerPair = headerLayout === "interleaved"
        ? createInterleavedHeaderPair({
            sab: controlSAB,
            byteOffset: interleavedHeadersSlice.byteOffset,
            slotCount,
            slotStrideU32: headerSlotStrideU32,
        })
        : {
            headerSlotStrideU32,
            requestHeaders: carpet.bind(controlSAB, requestHeadersSlice),
            returnHeaders: carpet.bind(controlSAB, returnHeadersSlice),
        };
    return {
        controlSAB,
        signals,
        abortSignals,
        lock: {
            headers: headerPair.requestHeaders,
            headerSlotStrideU32: headerPair.headerSlotStrideU32,
            lockSector: requestLockSector,
            payloadSector: requestLockSector,
        },
        returnLock: {
            headers: headerPair.returnHeaders,
            headerSlotStrideU32: headerPair.headerSlotStrideU32,
            lockSector: returnLockSector,
            payloadSector: returnLockSector,
        },
        slices: carpet.slices,
    };
};
