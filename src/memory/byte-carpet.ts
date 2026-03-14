import type { SharedBufferRegion } from "../common/shared-buffer-region.ts";

export const BYTE_CARPET_ALIGN_BYTES = 64;
const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;

const toNonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
};

export const alignBytes = (
  value: number,
  alignment = BYTE_CARPET_ALIGN_BYTES,
): number => {
  const safeValue = toNonNegativeInteger(value, "value");
  const safeAlignment = toNonNegativeInteger(alignment, "alignment");
  if (safeAlignment === 0) {
    throw new RangeError("alignment must be greater than zero");
  }
  return Math.ceil(safeValue / safeAlignment) * safeAlignment;
};

export const makeSharedBufferRegion = (
  sab: SharedArrayBuffer,
  byteOffset: number,
  byteLength: number,
): SharedBufferRegion => ({
  sab,
  byteOffset: toNonNegativeInteger(byteOffset, "byteOffset"),
  byteLength: toNonNegativeInteger(byteLength, "byteLength"),
});

export type ByteCarpetSlice = {
  name: string;
  byteOffset: number;
  byteLength: number;
  reservedByteLength: number;
};

export const createByteCarpet = ({
  alignTo = BYTE_CARPET_ALIGN_BYTES,
  startByteOffset = 0,
}: {
  alignTo?: number;
  startByteOffset?: number;
} = {}) => {
  const defaultAlignment = toNonNegativeInteger(alignTo, "alignTo");
  if (defaultAlignment === 0) {
    throw new RangeError("alignTo must be greater than zero");
  }

  let cursor = toNonNegativeInteger(startByteOffset, "startByteOffset");
  const slices: ByteCarpetSlice[] = [];

  const take = (
    name: string,
    byteLength: number,
    {
      alignTo: sliceAlignment = defaultAlignment,
      reserveByteLength,
    }: {
      alignTo?: number;
      reserveByteLength?: number;
    } = {},
  ): ByteCarpetSlice => {
    const logicalByteLength = toNonNegativeInteger(
      byteLength,
      `${name} byteLength`,
    );
    const safeSliceAlignment = toNonNegativeInteger(
      sliceAlignment,
      `${name} alignTo`,
    );
    if (safeSliceAlignment === 0) {
      throw new RangeError(`${name} alignTo must be greater than zero`);
    }
    const reserved = reserveByteLength == null
      ? alignBytes(logicalByteLength, safeSliceAlignment)
      : toNonNegativeInteger(reserveByteLength, `${name} reserveByteLength`);
    if (reserved < logicalByteLength) {
      throw new RangeError(
        `${name} reserveByteLength must cover byteLength`,
      );
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
    bind: (
      sab: SharedArrayBuffer,
      slice: ByteCarpetSlice,
    ): SharedBufferRegion =>
      makeSharedBufferRegion(sab, slice.byteOffset, slice.byteLength),
  };
};

export const getStridedSlotOffsetU32 = ({
  slotIndex,
  slotStrideU32,
  baseU32 = 0,
  extraU32 = 0,
}: {
  slotIndex: number;
  slotStrideU32: number;
  baseU32?: number;
  extraU32?: number;
}): number => (slotIndex * slotStrideU32) + baseU32 + extraU32;

export const getStridedSlotByteOffset = ({
  slotIndex,
  slotStrideU32,
  baseByteOffset = 0,
  baseU32 = 0,
  extraU32 = 0,
}: {
  slotIndex: number;
  slotStrideU32: number;
  baseByteOffset?: number;
  baseU32?: number;
  extraU32?: number;
}): number =>
  baseByteOffset +
  (getStridedSlotOffsetU32({
    slotIndex,
    slotStrideU32,
    baseU32,
    extraU32,
  }) * U32_BYTES);

export const getStridedRegionSpanBytes = ({
  slotCount,
  slotStrideU32,
  slotLengthU32,
  baseU32 = 0,
}: {
  slotCount: number;
  slotStrideU32: number;
  slotLengthU32: number;
  baseU32?: number;
}): number => {
  const safeSlotCount = toNonNegativeInteger(slotCount, "slotCount");
  if (safeSlotCount === 0) return 0;
  return (
    getStridedSlotOffsetU32({
      slotIndex: safeSlotCount - 1,
      slotStrideU32,
      baseU32,
    }) + slotLengthU32
  ) * U32_BYTES;
};

export const getInterleavedSlotStrideU32 = (slotStrideU32: number): number =>
  slotStrideU32 * 2;

export const getHeaderBlockByteLength = ({
  slotCount,
  slotStrideU32,
  queues = 1,
  alignTo = BYTE_CARPET_ALIGN_BYTES,
}: {
  slotCount: number;
  slotStrideU32: number;
  queues?: number;
  alignTo?: number;
}): number =>
  alignBytes(slotCount * slotStrideU32 * U32_BYTES * queues, alignTo);

export type HeaderLayoutMode = "split" | "interleaved";

export type QueueControlByteLayout = {
  headers: SharedBufferRegion;
  headerSlotStrideU32: number;
  lockSector: SharedBufferRegion;
  payloadSector: SharedBufferRegion;
};

export type LockControlCarpet = {
  controlSAB: SharedArrayBuffer;
  signals: SharedBufferRegion;
  abortSignals: SharedBufferRegion;
  lock: QueueControlByteLayout;
  returnLock: QueueControlByteLayout;
  slices: readonly ByteCarpetSlice[];
};

const createInterleavedHeaderPair = ({
  sab,
  byteOffset,
  slotCount,
  slotStrideU32,
}: {
  sab: SharedArrayBuffer;
  byteOffset: number;
  slotCount: number;
  slotStrideU32: number;
}) => {
  const headerSlotStrideU32 = getInterleavedSlotStrideU32(slotStrideU32);
  const slotBytes = slotStrideU32 * U32_BYTES;
  const spanBytes = getStridedRegionSpanBytes({
    slotCount,
    slotStrideU32: headerSlotStrideU32,
    slotLengthU32: slotStrideU32,
  });

  return {
    headerSlotStrideU32,
    requestHeaders: makeSharedBufferRegion(
      sab,
      byteOffset,
      spanBytes,
    ),
    returnHeaders: makeSharedBufferRegion(
      sab,
      byteOffset + slotBytes,
      spanBytes,
    ),
  };
};

export const createLockControlCarpet = ({
  signalBytes,
  abortBytes,
  lockSectorBytes,
  headerSlotStrideU32,
  slotCount,
  headerLayout = "interleaved",
  alignTo = BYTE_CARPET_ALIGN_BYTES,
  createBuffer = (byteLength: number) => new SharedArrayBuffer(byteLength),
}: {
  signalBytes: number;
  abortBytes: number;
  lockSectorBytes: number;
  headerSlotStrideU32: number;
  slotCount: number;
  headerLayout?: HeaderLayoutMode;
  alignTo?: number;
  createBuffer?: (byteLength: number) => SharedArrayBuffer;
}): LockControlCarpet => {
  const carpet = createByteCarpet({ alignTo });
  const signalsSlice = carpet.take("signals", signalBytes);
  const requestLockSlice = carpet.take("requestLockSector", lockSectorBytes);
  const returnLockSlice = carpet.take("returnLockSector", lockSectorBytes);

  let requestHeadersSlice: ByteCarpetSlice | undefined;
  let returnHeadersSlice: ByteCarpetSlice | undefined;
  let interleavedHeadersSlice: ByteCarpetSlice | undefined;
  if (headerLayout === "interleaved") {
    interleavedHeadersSlice = carpet.take(
      "interleavedHeaders",
      getHeaderBlockByteLength({
        slotCount,
        slotStrideU32: headerSlotStrideU32,
        queues: 2,
        alignTo,
      }),
    );
  } else {
    requestHeadersSlice = carpet.take(
      "requestHeaders",
      getHeaderBlockByteLength({
        slotCount,
        slotStrideU32: headerSlotStrideU32,
        alignTo,
      }),
    );
    returnHeadersSlice = carpet.take(
      "returnHeaders",
      getHeaderBlockByteLength({
        slotCount,
        slotStrideU32: headerSlotStrideU32,
        alignTo,
      }),
    );
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
      byteOffset: interleavedHeadersSlice!.byteOffset,
      slotCount,
      slotStrideU32: headerSlotStrideU32,
    })
    : {
      headerSlotStrideU32,
      requestHeaders: carpet.bind(controlSAB, requestHeadersSlice!),
      returnHeaders: carpet.bind(controlSAB, returnHeadersSlice!),
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
