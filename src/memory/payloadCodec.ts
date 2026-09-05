import {
  attachPayloadTransportFinalizer,
  beginPromisePayload,
  finishPromisePayload,
  HEADER_BYTE_LENGTH,
  HEADER_SLOT_STRIDE_U32,
  HEADER_STATIC_PAYLOAD_U32,
  LockBound,
  PayloadBuffer,
  payloadBufferName,
  PayloadSignal,
  type PromisePayloadHandler,
  registerLockPayloadCodec,
  type Task,
  TASK_SLOT_INDEX_MASK,
  TaskIndex,
} from "./lock.ts";
import { register } from "./regionRegistry.ts";
import {
  createSharedDynamicBufferIO,
  createSharedStaticBufferIO,
} from "./shared-buffer-io.ts";
import { getStridedRegionSpanBytes } from "./byte-carpet.ts";
import { encoderError, ErrorKnitting } from "../error.ts";
import { Envelope } from "../common/envelope.ts";
import type { LockBufferTextCompat } from "../common/shared-buffer-text.ts";
import {
  type PayloadBufferOptions,
  resolvePayloadBufferOptions,
} from "./payload-config.ts";
import {
  type SharedBufferSource,
  toSharedBufferRegion,
} from "../common/shared-buffer-region.ts";
import {
  getSharedArrayBufferPayload,
  SHARED_ARRAY_BUFFER_CODEC_ID,
  SHARED_ARRAY_BUFFER_NUMERIC_TRANSFER,
  SHARED_ARRAY_BUFFER_NUMERIC_WORDS,
} from "../connections/shared-array-buffer-payload.ts";
import {
  BUFFER_REFERENCE_NUMERIC_TRANSFER,
  BufferReference,
  isArrayBufferDetached,
  isBufferReferenceValue,
} from "../connections/buffer-reference.ts";
import {
  getBufferReferenceCapabilities,
} from "../connections/buffer-reference-native.ts";
import {
  isProcessSharedBufferValue,
  ProcessSharedBuffer,
} from "../connections/process-shared-buffer.ts";
import {
  isNumericArray,
  type NumericArray,
  numericArrayFromFloat64,
} from "../connections/numeric-array.ts";

type ExternalPayloadLike = {
  toMetadata: () => unknown;
};

type ExternalPayloadCodec = {
  decode: (metadata: unknown, transportKey?: object) => unknown;
  decodeNumeric?: (
    metadata: ArrayLike<number>,
    transportKey?: object,
  ) => unknown;
};

type BufferReferencePayloadLike = ExternalPayloadLike & {
  [BUFFER_REFERENCE_NUMERIC_TRANSFER]?: () => ArrayLike<number> | undefined;
};

type SharedArrayBufferPayloadLike = ExternalPayloadLike & {
  [SHARED_ARRAY_BUFFER_NUMERIC_TRANSFER]?: (
    transportKey?: object,
  ) => ArrayLike<number> | undefined;
};

type ProcessSharedBufferPayloadLike = ExternalPayloadLike & {
  descriptor?: {
    fd?: number;
    name?: string;
    size?: number;
    byteLength?: number;
    runtime?: unknown;
    kind?: unknown;
    baseAddressMod64?: number;
  };
  byteOffset?: number;
  byteLength?: number;
};

const memory = new ArrayBuffer(8);
const Float64View = new Float64Array(memory);
const BigInt64View = new BigInt64Array(memory);
const Uint32View = new Uint32Array(memory);
const textEncode = new TextEncoder();
const runtimeBufferClass = (globalThis as typeof globalThis & {
  Buffer?: {
    byteLength?: (value: string, encoding?: string) => number;
    isBuffer?: (candidate: unknown) => boolean;
  };
}).Buffer;
const runtimeBufferByteLength = typeof runtimeBufferClass?.byteLength ===
    "function"
  ? ((value: string, encoding?: string) =>
    runtimeBufferClass.byteLength!(value, encoding))
  : undefined;
const isRuntimeBuffer = (value: unknown): value is Uint8Array =>
  typeof runtimeBufferClass?.isBuffer === "function" &&
  runtimeBufferClass.isBuffer(value);
const isRuntimeUint8Array = (value: unknown): value is Uint8Array =>
  value != null &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Uint8Array.prototype;
const utf8ByteLength = !runtimeBufferByteLength
  ? (text: string): number => textEncode.encode(text).byteLength
  : (text: string): number => runtimeBufferByteLength(text, "utf8");
const BIGINT64_MIN = -(1n << 63n);
const BIGINT64_MAX = (1n << 63n) - 1n;
const { parse: parseJSON, stringify: stringifyJSON } = JSON;
const { for: symbolFor, keyFor: symbolKeyFor } = Symbol;
const EXTERNAL_PAYLOAD_BRAND = symbolFor("knitting.payloadCodec");
const BUFFER_REFERENCE_CODEC_ID = "knitting.bufferReference";
const PROCESS_SHARED_BUFFER_CODEC_ID = "knitting.processSharedBuffer";
const externalPayloadGlobal = globalThis as typeof globalThis & {
  __KNITTING_PAYLOAD_CODECS__?: Record<
    string,
    ExternalPayloadCodec | undefined
  >;
};
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.prototype.hasOwnProperty;
const arrayIsArray = Array.isArray;
const objectPrototype = Object.prototype;
const UNSUPPORTED_OBJECT_DETAIL =
  "Unsupported object type. Allowed: plain object, array, Error, Date, Envelope, Buffer, ArrayBuffer, DataView, typed arrays, and registered external payloads. Serialize it yourself.";
const ENVELOPE_PAYLOAD_DETAIL =
  "Envelope payload must be an ArrayBuffer, SharedArrayBuffer, " +
  "ProcessSharedBuffer, or BufferReference.";
const ENVELOPE_HEADER_DETAIL =
  "Envelope header must be a JSON-like value or string.";
const ENVELOPE_PROMISE_DETAIL =
  "Envelope header cannot contain Promise values.";
const DYNAMIC_PAYLOAD_LIMIT_DETAIL = "Dynamic payload exceeds maxPayloadBytes.";
const DYNAMIC_PAYLOAD_CAPACITY_DETAIL =
  "Dynamic payload buffer capacity exceeded.";
const PROCESS_BOUNDARY_POINTER_PAYLOAD_DETAIL =
  "SharedArrayBuffer and BufferReference are process-local pointer payloads " +
  "and cannot cross a process-worker boundary; use ProcessSharedBuffer instead.";
const RESERVED_EXTERNAL_PAYLOAD_DETAIL =
  "Reserved Knitting external payload codec cannot be forged.";

const isProcessLocalPointerCodec = (codecId: string): boolean =>
  codecId === SHARED_ARRAY_BUFFER_CODEC_ID ||
  codecId === BUFFER_REFERENCE_CODEC_ID;

const isReservedExternalPayloadCodec = (codecId: string): boolean =>
  isProcessLocalPointerCodec(codecId) ||
  codecId === PROCESS_SHARED_BUFFER_CODEC_ID;

const isPlainJsonObject = (value: object) => {
  const proto = objectGetPrototypeOf(value);
  return proto === objectPrototype || proto === null;
};

const readExternalPayloadCodecId = (value: object): string | undefined => {
  const codecId = (value as Record<symbol, unknown>)[EXTERNAL_PAYLOAD_BRAND];
  return typeof codecId === "string" ? codecId : undefined;
};

const runtimeCode = (value: unknown): number => {
  switch (value) {
    case "node":
      return 1;
    case "deno":
      return 2;
    case "bun":
      return 3;
    default:
      return 0;
  }
};

const kindCode = (value: unknown): number => {
  switch (value) {
    case "shared-array-buffer":
      return 1;
    case "external-array-buffer":
      return 2;
    default:
      return 0;
  }
};

const isU32 = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 0xffffffff;

const isExternalPayloadLike = (value: object): value is ExternalPayloadLike =>
  typeof (value as ExternalPayloadLike).toMetadata === "function" &&
  typeof (value as Record<symbol, unknown>)[EXTERNAL_PAYLOAD_BRAND] ===
    "string";

const readTrustedExternalPayloadMetadata = (
  value: ExternalPayloadLike,
): unknown => {
  if (isBufferReferenceValue(value)) {
    return BufferReference.prototype.toMetadata.call(value);
  }
  if (isProcessSharedBufferValue(value)) {
    return ProcessSharedBuffer.prototype.toMetadata.call(value);
  }
  return value.toMetadata();
};

const decodeExternalPayload = (
  raw: string,
  processBoundary: boolean,
  transportKey?: object,
): unknown => {
  const payload = parseJSON(raw);
  if (!arrayIsArray(payload) || payload.length !== 2) return payload;

  const codecId = payload[0];
  const metadata = payload[1];
  if (typeof codecId !== "string") {
    return { codec: codecId, metadata };
  }
  if (processBoundary && isProcessLocalPointerCodec(codecId)) {
    throw new TypeError(PROCESS_BOUNDARY_POINTER_PAYLOAD_DETAIL);
  }

  const codec = externalPayloadGlobal.__KNITTING_PAYLOAD_CODECS__?.[codecId];
  return typeof codec?.decode === "function"
    ? codec.decode(metadata, transportKey)
    : { codec: codecId, metadata };
};

const PROCESS_SHARED_BUFFER_NUMERIC_WORDS = 8;
const BUFFER_REFERENCE_NUMERIC_WORDS = 8;
const NUMERIC_SENTINEL = 0xffffffff;

/** Minimum size for automatically borrowed byte returns. */
export const SHARED_RETURN_MIN_BYTES = 256 * 1024;

/** Number of later borrowed returns kept before a region is recycled. */
export const SHARED_RETURN_BORROW_WINDOW = 32;

// Each payload buffer has one allocator for the worker return lane.
const sharedReturnAllocators = new WeakMap<
  object,
  (byteLength: number, zeroFill?: boolean) => Uint8Array | undefined
>();

/** The borrowed-region allocator for `payload`, if an encoder built one. */
export const getSharedReturnAllocator = (
  payload: object,
): ((byteLength: number, zeroFill?: boolean) => Uint8Array | undefined) |
  undefined => sharedReturnAllocators.get(payload);

const decodeNumericExternalPayload = (
  codecId: string,
  words: ArrayLike<number>,
  transportKey?: object,
): unknown => {
  const codec = externalPayloadGlobal.__KNITTING_PAYLOAD_CODECS__?.[codecId];
  if (typeof codec?.decodeNumeric === "function") {
    return codec.decodeNumeric(words, transportKey);
  }
  return { codec: codecId, metadata: Array.from(words) };
};

const decodeProcessSharedBufferNumericWords = (
  words: ArrayLike<number>,
): unknown =>
  decodeNumericExternalPayload(PROCESS_SHARED_BUFFER_CODEC_ID, words);

const decodeBufferReferenceNumericWords = (
  words: ArrayLike<number>,
): unknown => decodeNumericExternalPayload(BUFFER_REFERENCE_CODEC_ID, words);

// The transport key scopes the host's adopted-alias cache to one return lane:
// producer tokens restart at 1 in every worker isolate, so a shared cache would
// serve one worker's buffer for another worker's identical token.
const decodeSharedArrayBufferNumericWords = (
  words: ArrayLike<number>,
  transportKey?: object,
): unknown =>
  decodeNumericExternalPayload(
    SHARED_ARRAY_BUFFER_CODEC_ID,
    words,
    transportKey,
  );

const tryEncodePrimitiveTask = (task: Task): boolean => {
  const value = task.value;
  switch (typeof value) {
    case "number":
      if (value !== value) {
        task[TaskIndex.Type] = PayloadSignal.NaN;
        return true;
      }
      Float64View[0] = value;
      task[TaskIndex.Type] = PayloadSignal.Float64;
      task[TaskIndex.Start] = Uint32View[0]!;
      task[TaskIndex.End] = Uint32View[1]!;
      return true;
    case "boolean":
      task[TaskIndex.Type] = value ? PayloadSignal.True : PayloadSignal.False;
      return true;
    case "undefined":
      task[TaskIndex.Type] = PayloadSignal.Undefined;
      return true;
    case "bigint":
      if (value < BIGINT64_MIN || value > BIGINT64_MAX) return false;
      BigInt64View[0] = value;
      task[TaskIndex.Type] = PayloadSignal.BigInt;
      task[TaskIndex.Start] = Uint32View[0]!;
      task[TaskIndex.End] = Uint32View[1]!;
      return true;
    case "object":
      if (value === null) {
        task[TaskIndex.Type] = PayloadSignal.Null;
        return true;
      }
      return false;
    default:
      return false;
  }
};

const hasPromiseInEnvelopeHeader = (
  value: unknown,
  seen?: Set<object>,
): boolean => {
  if (value instanceof Promise) return true;
  if (value === null || typeof value !== "object") return false;

  const objectValue = value as object;
  const visited = seen ?? new Set<object>();
  if (visited.has(objectValue)) return false;
  visited.add(objectValue);

  if (arrayIsArray(objectValue)) {
    const list = objectValue as unknown[];
    for (let i = 0; i < list.length; i++) {
      if (hasPromiseInEnvelopeHeader(list[i], visited)) return true;
    }
    return false;
  }

  if (!isPlainJsonObject(objectValue)) return false;

  const record = objectValue as Record<string, unknown>;
  for (const key in record) {
    if (!objectHasOwn.call(record, key)) continue;
    if (hasPromiseInEnvelopeHeader(record[key], visited)) return true;
  }
  return false;
};

type ErrorPayload = {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
};

const toErrorCause = (cause: unknown): unknown => {
  if (cause === null || cause === undefined) return cause;
  switch (typeof cause) {
    case "string":
    case "number":
    case "boolean":
      return cause;
    case "bigint":
      return cause.toString();
    case "symbol":
    case "function":
      return String(cause);
  }
  if (cause instanceof Error) {
    const nested: ErrorPayload = {
      name: cause.name,
      message: cause.message,
    };
    if (typeof cause.stack === "string") nested.stack = cause.stack;
    if (objectHasOwn.call(cause as object, "cause")) {
      nested.cause = toErrorCause(
        (cause as Error & { cause?: unknown }).cause,
      );
    }
    return nested;
  }
  try {
    return parseJSON(stringifyJSON(cause));
  } catch {
    return String(cause);
  }
};

const toErrorPayload = (error: Error): ErrorPayload => {
  const payload: ErrorPayload = {
    name: error.name,
    message: error.message,
  };
  if (typeof error.stack === "string") payload.stack = error.stack;
  if (objectHasOwn.call(error as object, "cause")) {
    payload.cause = toErrorCause((error as Error & { cause?: unknown }).cause);
  }
  return payload;
};

const parseErrorPayload = (raw: string): Error => {
  let parsed: unknown;
  try {
    parsed = parseJSON(raw);
  } catch {
    return new Error(raw);
  }
  if (parsed == null || typeof parsed !== "object") {
    return new Error(String(parsed));
  }
  const payload = parsed as Partial<ErrorPayload>;
  const err = new Error(
    typeof payload.message === "string" ? payload.message : "",
  );
  if (typeof payload.name === "string" && payload.name.length > 0) {
    err.name = payload.name;
  }
  if (typeof payload.stack === "string") {
    try {
      err.stack = payload.stack;
    } catch {
    }
  }
  if (objectHasOwn.call(payload as object, "cause")) {
    (err as Error & { cause?: unknown }).cause = payload.cause;
  }
  return err;
};

const decodeBigIntBinary = (bytes: Uint8Array) => {
  const sign = bytes[0];
  let value = 0n;
  for (let i = bytes.length - 1; i >= 1; i--) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return sign === 1 ? -value : value;
};

const initStaticIO = (
  headersBuffer: Uint32Array,
  headerSlotStrideU32?: number,
  textCompat?: LockBufferTextCompat["headers"],
) => {
  const slotStride = headerSlotStrideU32 ?? HEADER_SLOT_STRIDE_U32;
  const requiredBytes = getStridedRegionSpanBytes({
    slotCount: LockBound.slots,
    slotStrideU32: slotStride,
    slotLengthU32: HEADER_STATIC_PAYLOAD_U32,
    baseU32: LockBound.header,
  });
  if (headersBuffer.byteLength < Math.max(requiredBytes, HEADER_BYTE_LENGTH)) {
    return null;
  }

  return createSharedStaticBufferIO({
    headersBuffer,
    slotStrideU32: slotStride,
    textCompat,
  });
};

const requireStaticIO = (
  headersBuffer: Uint32Array,
  headerSlotStrideU32?: number,
  textCompat?: LockBufferTextCompat["headers"],
) => {
  const staticIO = initStaticIO(headersBuffer, headerSlotStrideU32, textCompat);
  if (staticIO === null) {
    throw new RangeError("headersBuffer is too small for static payload IO");
  }
  return staticIO;
};

/**
 * Returns `true` when the payload is encoded successfully.
 * Returns `false` when dynamic payload space could not be reserved.
 */

export const encodePayload = ({
  lockSector,
  payload,
  sab,
  payloadConfig,
  headersBuffer,
  headerSlotStrideU32,
  textCompat,
  onPromise,
  processBoundary = false,
  sharedReturn = false,
  moveReturn = false,
}: {
  lockSector?: SharedBufferSource;
  payload?: {
    sab?: SharedBufferSource;
    config?: PayloadBufferOptions;
  };
  /**
   * @deprecated Use `payload.sab`.
   */
  sab?: SharedBufferSource;
  /**
   * @deprecated Use `payload.config`.
   */
  payloadConfig?: PayloadBufferOptions;
  headersBuffer: Uint32Array;
  headerSlotStrideU32?: number;
  textCompat?: LockBufferTextCompat;
  onPromise?: PromisePayloadHandler;
  /**
   * Reject process-local pointer payloads while preserving ProcessSharedBuffer.
   * Process transports must set this on both encoders and decoders.
   */
  processBoundary?: boolean;
  /**
   * Enable explicit `sharedBytes()` allocations on a worker return lane.
   * Ordinary byte returns never become borrowed implicitly.
   */
  sharedReturn?: boolean;
  /**
   * Move large top-level byte returns into an owned host ArrayBuffer. Unlike a
   * borrowed return, the result stays valid until the host drops it.
   */
  moveReturn?: boolean;
}) => {
  const payloadSab = payload?.sab ?? sab;
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payloadSab,
    options: payload?.config ?? payloadConfig,
  });
  const maxPayloadBytes = resolvedPayloadConfig.maxPayloadBytes;
  // Automatic moves are an optimization. Keep ordinary byte returns working
  // when this runtime has no usable ownership/FFI backend.
  const canMoveReturn = moveReturn && (() => {
    try {
      getBufferReferenceCapabilities();
      return true;
    } catch {
      return false;
    }
  })();

  const registryHandle = register({ lockSector });
  const { allocTask, setSlotLength, tagTaskSlot, free } = registryHandle;
  const { allocRegion, regionStart } = registryHandle;
  const {
    writeBinary: writeDynamicBinary,
    writeBuffer: writeDynamicBuffer,
    writeArrayBuffer: writeDynamicArrayBuffer,
    write8Binary: writeDynamic8Binary,
    writeUtf8: writeDynamicUtf8,
    readBytesView: dynamicRegionView,
    ensureCapacity: ensureDynamicCapacity,
    currentBuffer: currentDynamicBuffer,
    regionBase: dynamicRegionBase,
  } = createSharedDynamicBufferIO({
    sab: payloadSab,
    payloadConfig: resolvedPayloadConfig,
    textCompat: textCompat?.payload,
  });
  const {
    maxBytes: staticMaxBytes,
    writeBinary: writeStaticBinary,
    writeBuffer: writeStaticBuffer,
    writeArrayBuffer: writeStaticArrayBuffer,
    writeExactUint8Array: writeStaticExactUint8Array,
    writeU32Words: writeStaticU32Words,
    write8Binary: writeStatic8Binary,
    writeUtf8: writeStaticUtf8,
  } = requireStaticIO(
    headersBuffer,
    headerSlotStrideU32,
    textCompat?.headers,
  );
  const dynamicLimitError = (
    task: Task,
    actualBytes: number,
    label: string,
  ) =>
    encoderError({
      task,
      type: ErrorKnitting.Serializable,
      onPromise,
      detail: `${DYNAMIC_PAYLOAD_LIMIT_DETAIL} limit=${maxPayloadBytes}; ` +
        `actual=${actualBytes}; type=${label}.`,
    });
  const dynamicCapacityError = (task: Task) =>
    encoderError({
      task,
      type: ErrorKnitting.Serializable,
      onPromise,
      detail: DYNAMIC_PAYLOAD_CAPACITY_DETAIL,
    });
  const ensureWithinDynamicLimit = (
    task: Task,
    bytes: number,
    label: string,
  ) => {
    if (bytes <= maxPayloadBytes) return true;
    return dynamicLimitError(task, bytes, label);
  };
  const dynamicUtf8ReserveBytesWithExtra = (
    task: Task,
    text: string,
    extraBytes: number,
    label: string,
  ): number => {
    const estimatedBytes = text.length * 3;
    const estimatedTotal = estimatedBytes + extraBytes;
    if (estimatedTotal <= maxPayloadBytes) return estimatedBytes;

    const exactBytes = utf8ByteLength(text);
    const exactTotal = exactBytes + extraBytes;
    if (exactTotal > maxPayloadBytes) {
      dynamicLimitError(task, exactTotal, label);
      return -1;
    }
    return exactBytes;
  };
  const dynamicUtf8ReserveBytes = (
    task: Task,
    text: string,
    label: string,
  ): number => dynamicUtf8ReserveBytesWithExtra(task, text, 0, label);

  // Borrowed regions are tracked as [slot, start, end] triples, oldest first.
  const borrowed: number[] = [];
  const BORROW_STRIDE = 3;

  /** Limit borrowed regions to half the payload arena. */
  const maxBorrowBytes =
    ((resolvedPayloadConfig.payloadMaxByteLength >> 1) /
      SHARED_RETURN_BORROW_WINDOW) | 0;

  /** Reserve a region to hand over by reference, or -1 when none is free. */
  const reserveBorrowedRegion = (bytes: number): number => {
    if (bytes > maxBorrowBytes) return -1;
    const slot = allocRegion(bytes);
    if (slot === -1) return -1;
    const start = regionStart(slot);
    if (!ensureDynamicCapacity(start + bytes)) {
      free(slot);
      return -1;
    }
    borrowed.push(slot, start, start + bytes);
    if (borrowed.length > SHARED_RETURN_BORROW_WINDOW * BORROW_STRIDE) {
      free(borrowed[0]!);
      borrowed.splice(0, BORROW_STRIDE);
    }
    return slot;
  };

  const dropBorrowedRegion = (slot: number): void => {
    for (let at = 0; at < borrowed.length; at += BORROW_STRIDE) {
      if (borrowed[at] === slot) {
        borrowed.splice(at, BORROW_STRIDE);
        break;
      }
    }
    free(slot);
  };

  /** Return the arena offset when `view` is inside a live borrowed region. */
  const borrowedStartOf = (view: Uint8Array): number => {
    if (borrowed.length === 0) return -1;
    if (view.buffer !== currentDynamicBuffer()) return -1;
    const start = view.byteOffset - dynamicRegionBase();
    const end = start + view.byteLength;
    for (let at = borrowed.length - BORROW_STRIDE; at >= 0; at -= BORROW_STRIDE) {
      if (start >= borrowed[at + 1]! && end <= borrowed[at + 2]!) return start;
    }
    return -1;
  };

  /** Allocate a borrowed return region, or fall back when none is available. */
  const allocateSharedReturn = (
    byteLength: number,
    zeroFill = false,
  ): Uint8Array | undefined => {
    const slot = reserveBorrowedRegion(byteLength);
    if (slot === -1) return undefined;
    const start = regionStart(slot);
    const view = dynamicRegionView(start, start + byteLength);
    if (zeroFill) view.fill(0);
    return view;
  };
  if (sharedReturn && payloadSab !== undefined) {
    sharedReturnAllocators.set(payloadSab as object, allocateSharedReturn);
  }

  const reserveDynamic = (task: Task, bytes: number) => {
    task[TaskIndex.PayloadLen] = bytes;
    // -1 is dynamic-region backpressure. Returning false leaves this frame on
    // the lock's existing pending list until a receiver releases a region.
    return allocTask(task);
  };
  let objectDynamicSlot = -1;
  const reserveDynamicObject = (task: Task, bytes: number) => {
    task[TaskIndex.PayloadLen] = bytes;
    const reservedSlot = allocTask(task);
    objectDynamicSlot = reservedSlot;
    return reservedSlot;
  };
  const rollbackObjectDynamic = () => {
    if (objectDynamicSlot !== -1) {
      free(objectDynamicSlot);
      objectDynamicSlot = -1;
    }
  };
  const failDynamicWriteAfterReserve = (task: Task, reservedSlot: number) => {
    free(reservedSlot);
    if (objectDynamicSlot === reservedSlot) objectDynamicSlot = -1;
    return dynamicCapacityError(task);
  };

  let bigintScratch = new Uint8Array(16);
  const encodeBigIntIntoScratch = (value: bigint) => {
    let sign = 0;
    let abs = value;
    if (value < 0n) {
      sign = 1;
      abs = -value;
    }

    let at = 1;
    while (abs > 0n) {
      if (at >= bigintScratch.byteLength) {
        const next = new Uint8Array(bigintScratch.byteLength << 1);
        next.set(bigintScratch, 0);
        bigintScratch = next;
      }
      bigintScratch[at++] = Number(abs & 0xffn);
      abs >>= 8n;
    }

    bigintScratch[0] = sign;
    return at;
  };
  const clearBigIntScratch = (used: number) => {
    bigintScratch.fill(0, 0, used);
  };
  const encodeErrorObject = (
    task: Task,
    error: Error,
  ) => {
    let text: string;
    try {
      text = stringifyJSON(toErrorPayload(error));
    } catch (encodeErrorReason) {
      const detail = encodeErrorReason instanceof Error
        ? encodeErrorReason.message
        : String(encodeErrorReason);
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail,
      });
    }
    const reserveBytes = dynamicUtf8ReserveBytes(task, text, "Error");
    if (reserveBytes < 0) return false;
    task[TaskIndex.Type] = PayloadBuffer.Error;
    const reservedSlot = reserveDynamicObject(task, reserveBytes);
    if (reservedSlot === -1) return false;
    const written = writeDynamicUtf8(
      text,
      task[TaskIndex.Start],
      reserveBytes,
    );
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };

  const encodeObjectBinary = (
    task: Task,
    slotIndex: number,
    bytesView: Uint8Array,
    dynamicType: PayloadBuffer,
    staticType: PayloadBuffer,
  ) => {
    const bytes = bytesView.byteLength;
    if (bytes <= staticMaxBytes) {
      const written = writeStaticBinary(bytesView, slotIndex);
      if (written !== -1) {
        task[TaskIndex.Type] = staticType;
        task[TaskIndex.PayloadLen] = written;
        task.value = null;
        return true;
      }
    }

    task[TaskIndex.Type] = dynamicType;
    if (
      !ensureWithinDynamicLimit(task, bytes, payloadBufferName(dynamicType))
    ) {
      return false;
    }
    const reservedSlot = reserveDynamicObject(task, bytes);
    if (reservedSlot === -1) return false;
    const written = writeDynamicBinary(bytesView, task[TaskIndex.Start]);
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const encodeObjectUint8Array = (
    task: Task,
    slotIndex: number,
    bytesView: Uint8Array,
  ) => {
    const bytes = bytesView.byteLength;
    // Preserve an arena-backed subarray as an offset/length frame.
    const borrowedStart = borrowedStartOf(bytesView);
    if (borrowedStart !== -1) {
      task[TaskIndex.Type] = PayloadBuffer.ArenaBinary;
      task[TaskIndex.Start] = borrowedStart;
      task[TaskIndex.PayloadLen] = bytes;
      task.value = null;
      return true;
    }
    if (bytes <= staticMaxBytes) {
      writeStaticExactUint8Array(bytesView, slotIndex);
      task[TaskIndex.Type] = PayloadBuffer.StaticBinary;
      task[TaskIndex.PayloadLen] = bytes;
      task.value = null;
      return true;
    }

    if (
      canMoveReturn && bytes >= SHARED_RETURN_MIN_BYTES &&
      tryEncodeMovedReturn(
        task,
        slotIndex,
        bytesView,
        PayloadBuffer.MovedBinary,
      )
    ) {
      return true;
    }

    task[TaskIndex.Type] = PayloadBuffer.Binary;
    if (!ensureWithinDynamicLimit(task, bytes, "Binary")) return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    if (reservedSlot === -1) return false;
    const written = writeDynamicBinary(bytesView, task[TaskIndex.Start]);
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const encodeObjectBuffer = (
    task: Task,
    slotIndex: number,
    buffer: Uint8Array,
  ) => {
    const bytes = buffer.byteLength;
    if (bytes <= staticMaxBytes) {
      const written = writeStaticBuffer(buffer, slotIndex);
      if (written !== -1) {
        task[TaskIndex.Type] = PayloadBuffer.StaticBuffer;
        task[TaskIndex.PayloadLen] = written;
        task.value = null;
        return true;
      }
    }

    task[TaskIndex.Type] = PayloadBuffer.Buffer;
    if (!ensureWithinDynamicLimit(task, bytes, "Buffer")) return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    if (reservedSlot === -1) return false;
    const written = writeDynamicBuffer(buffer, task[TaskIndex.Start]);
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };

  const encodeObjectFloat64Array = (
    task: Task,
    slotIndex: number,
    float64: Float64Array,
  ) => {
    const bytes = float64.byteLength;
    if (bytes <= staticMaxBytes) {
      const written = writeStatic8Binary(float64, slotIndex);
      if (written !== -1) {
        task[TaskIndex.Type] = PayloadBuffer.StaticFloat64Array;
        task[TaskIndex.PayloadLen] = written;
        task.value = null;
        return true;
      }
    }

    task[TaskIndex.Type] = PayloadBuffer.Float64Array;
    if (!ensureWithinDynamicLimit(task, bytes, "Float64Array")) return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    if (reservedSlot === -1) return false;
    const written = writeDynamic8Binary(float64, task[TaskIndex.Start]);
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  let numericArrayScratch = new Float64Array(0);
  const encodeObjectNumericArray = (
    task: Task,
    slotIndex: number,
    numericArray: NumericArray,
  ) => {
    const length = numericArray.length;
    if (numericArrayScratch.length < length) {
      numericArrayScratch = new Float64Array(length);
    }
    for (let i = 0; i < length; i++) numericArrayScratch[i] = numericArray[i]!;
    const float64 = numericArrayScratch.subarray(0, length);
    const bytes = float64.byteLength;
    if (bytes <= staticMaxBytes) {
      const written = writeStatic8Binary(float64, slotIndex);
      if (written !== -1) {
        task[TaskIndex.Type] = PayloadBuffer.StaticNumericArray;
        task[TaskIndex.PayloadLen] = written;
        task.value = null;
        return true;
      }
    }

    task[TaskIndex.Type] = PayloadBuffer.NumericArray;
    if (!ensureWithinDynamicLimit(task, bytes, "NumericArray")) return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    if (reservedSlot === -1) return false;
    const written = writeDynamic8Binary(float64, task[TaskIndex.Start]);
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const encodeObjectArrayBuffer = (
    task: Task,
    slotIndex: number,
    arrayBuffer: ArrayBuffer,
  ) => {
    const bytes = arrayBuffer.byteLength;
    if (bytes <= staticMaxBytes) {
      const written = writeStaticArrayBuffer(arrayBuffer, slotIndex);
      if (written !== -1) {
        task[TaskIndex.Type] = PayloadBuffer.StaticArrayBuffer;
        task[TaskIndex.PayloadLen] = written;
        task.value = null;
        return true;
      }
    }

    if (
      canMoveReturn && bytes >= SHARED_RETURN_MIN_BYTES &&
      tryEncodeMovedReturn(
        task,
        slotIndex,
        arrayBuffer,
        PayloadBuffer.MovedArrayBuffer,
      )
    ) {
      return true;
    }

    task[TaskIndex.Type] = PayloadBuffer.ArrayBuffer;
    if (!ensureWithinDynamicLimit(task, bytes, "ArrayBuffer")) return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    if (reservedSlot === -1) return false;
    const written = writeDynamicArrayBuffer(arrayBuffer, task[TaskIndex.Start]);
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const processSharedBufferWords = new Uint32Array(
    PROCESS_SHARED_BUFFER_NUMERIC_WORDS,
  );
  const sharedArrayBufferWords = new Uint32Array(
    SHARED_ARRAY_BUFFER_NUMERIC_WORDS,
  );
  const tryEncodeProcessSharedBufferNumeric = (
    task: Task,
    slotIndex: number,
    value: ProcessSharedBufferPayloadLike,
  ): boolean => {
    const descriptor = value.descriptor;
    if (
      descriptor === undefined ||
      descriptor.name !== undefined ||
      !isU32(descriptor.fd) ||
      !isU32(descriptor.size) ||
      !isU32(descriptor.byteLength) ||
      !isU32(value.byteOffset) ||
      !isU32(value.byteLength)
    ) {
      return false;
    }

    const baseAddressMod64 = descriptor.baseAddressMod64;
    if (
      baseAddressMod64 !== undefined &&
      !isU32(baseAddressMod64)
    ) {
      return false;
    }

    processSharedBufferWords[0] = descriptor.fd;
    processSharedBufferWords[1] = descriptor.size;
    processSharedBufferWords[2] = descriptor.byteLength;
    processSharedBufferWords[3] = value.byteOffset;
    processSharedBufferWords[4] = value.byteLength;
    processSharedBufferWords[5] = runtimeCode(descriptor.runtime);
    processSharedBufferWords[6] = kindCode(descriptor.kind);
    processSharedBufferWords[7] = baseAddressMod64 === undefined
      ? NUMERIC_SENTINEL
      : baseAddressMod64;

    task[TaskIndex.Type] = PayloadBuffer.ProcessSharedBuffer;
    // Static region is a Uint32Array shared in-process; write the descriptor
    // words straight in instead of staging bytes through a DataView + copy.
    task[TaskIndex.PayloadLen] = writeStaticU32Words(
      processSharedBufferWords,
      PROCESS_SHARED_BUFFER_NUMERIC_WORDS,
      slotIndex,
    );
    task.value = null;
    return true;
  };
  const tryEncodeBufferReferenceNumeric = (
    task: Task,
    slotIndex: number,
    value: BufferReferencePayloadLike,
  ): boolean => {
    const words = isBufferReferenceValue(value)
      ? BufferReference.prototype[BUFFER_REFERENCE_NUMERIC_TRANSFER].call(
        value,
      )
      : value[BUFFER_REFERENCE_NUMERIC_TRANSFER]?.();
    if (words === undefined) return false;

    task[TaskIndex.Type] = PayloadBuffer.BufferReference;
    task[TaskIndex.PayloadLen] = writeStaticU32Words(
      words,
      BUFFER_REFERENCE_NUMERIC_WORDS,
      slotIndex,
    );
    attachPayloadTransportFinalizer(task, value);
    task.value = null;
    return true;
  };
  /**
   * The safe counterpart to an arena borrow. The producer's source is detached
   * only after its task has settled; the host adopts the backing store before
   * its acknowledgement lets the producer release the registry pin.
   *
   * This needs its own frame type because public task results remain ordinary
   * Uint8Array / ArrayBuffer values rather than exposing BufferReference.
   */
  const tryEncodeMovedReturn = (
    task: Task,
    slotIndex: number,
    source: Uint8Array | ArrayBuffer,
    type:
      | typeof PayloadBuffer.MovedBinary
      | typeof PayloadBuffer.MovedArrayBuffer,
  ): boolean => {
    if (source.byteLength > 0xffffffff) return false;
    const backing = ArrayBuffer.isView(source) ? source.buffer : source;
    if (
      typeof SharedArrayBuffer === "function" &&
      backing instanceof SharedArrayBuffer
    ) {
      return false;
    }
    // Narrowed by the check above: what is left is a detachable ArrayBuffer.
    const store = backing as ArrayBuffer;

    // A move takes the whole backing store, not the slice that was returned.
    // `return scratch.subarray(0, n)` would detach the producer's entire
    // scratch buffer and break its next call, so a partial view is copied
    // like any other return. Only a view that *is* its buffer can move.
    if (
      ArrayBuffer.isView(source) &&
      (source.byteOffset !== 0 || source.byteLength !== store.byteLength)
    ) {
      return false;
    }

    // Moving is an optimization, so a source this runtime cannot detach --
    // WASM memory, a buffer an external API pinned -- copies rather than
    // failing the task. Construction is what detaches: a throw before it
    // leaves the bytes intact and the copy path still works, while a throw
    // after it has already consumed them has to be reported.
    let reference: BufferReference;
    try {
      reference = new BufferReference(source);
    } catch (error) {
      if (isArrayBufferDetached(store)) throw error;
      return false;
    }

    // Belt and braces for a runtime that reports success without detaching.
    // The host would be handed a store still aliasing memory the producer can
    // write; the source is intact in that case, so dropping the reference and
    // copying is both safe and the honest answer.
    if (!isArrayBufferDetached(store)) {
      reference.release();
      return false;
    }

    const words = BufferReference.prototype[BUFFER_REFERENCE_NUMERIC_TRANSFER]
      .call(reference);

    // The size check above guarantees the numeric form for a local reference.
    // Do not fall back after construction: the source has intentionally moved.
    if (words === undefined) {
      reference.release();
      throw new Error("Moved BufferReference has no numeric transport form");
    }

    task[TaskIndex.Type] = type;
    task[TaskIndex.PayloadLen] = writeStaticU32Words(
      words,
      BUFFER_REFERENCE_NUMERIC_WORDS,
      slotIndex,
    );
    attachPayloadTransportFinalizer(task, reference);
    task.value = null;
    return true;
  };
  const tryEncodeSharedArrayBufferNumeric = (
    task: Task,
    slotIndex: number,
    value: SharedArrayBufferPayloadLike,
  ): boolean => {
    const words = value[SHARED_ARRAY_BUFFER_NUMERIC_TRANSFER]?.(
      lockSector as object | undefined,
    );
    if (words === undefined) return false;

    sharedArrayBufferWords[0] = words[0] ?? 0;
    sharedArrayBufferWords[1] = words[1] ?? 0;
    sharedArrayBufferWords[2] = words[2] ?? 0;
    sharedArrayBufferWords[3] = words[3] ?? 0;
    sharedArrayBufferWords[4] = words[4] ?? 0;
    sharedArrayBufferWords[5] = words[5] ?? 0;
    sharedArrayBufferWords[6] = words[6] ?? 0;
    sharedArrayBufferWords[7] = words[7] ?? 0;

    task[TaskIndex.Type] = PayloadBuffer.SharedArrayBuffer;
    task[TaskIndex.PayloadLen] = writeStaticU32Words(
      sharedArrayBufferWords,
      words.length,
      slotIndex,
    );
    task.value = null;
    return true;
  };
  const encodeObjectExternalPayload = (
    task: Task,
    slotIndex: number,
    externalPayload: ExternalPayloadLike,
    trustedReservedCodec = false,
  ) => {
    const codecId = readExternalPayloadCodecId(externalPayload as object);
    if (codecId === undefined) {
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: UNSUPPORTED_OBJECT_DETAIL,
      });
    }
    if (trustedReservedCodec) {
      if (processBoundary && isProcessLocalPointerCodec(codecId)) {
        return encoderError({
          task,
          type: ErrorKnitting.Serializable,
          onPromise,
          detail: PROCESS_BOUNDARY_POINTER_PAYLOAD_DETAIL,
        });
      }

      if (
        codecId === SHARED_ARRAY_BUFFER_CODEC_ID &&
        tryEncodeSharedArrayBufferNumeric(
          task,
          slotIndex,
          externalPayload as SharedArrayBufferPayloadLike,
        )
      ) {
        return true;
      }

      if (
        codecId === BUFFER_REFERENCE_CODEC_ID &&
        tryEncodeBufferReferenceNumeric(
          task,
          slotIndex,
          externalPayload as BufferReferencePayloadLike,
        )
      ) {
        return true;
      }

      if (
        codecId === PROCESS_SHARED_BUFFER_CODEC_ID &&
        tryEncodeProcessSharedBufferNumeric(
          task,
          slotIndex,
          externalPayload as ProcessSharedBufferPayloadLike,
        )
      ) {
        return true;
      }
    } else if (isReservedExternalPayloadCodec(codecId)) {
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: processBoundary && isProcessLocalPointerCodec(codecId)
          ? PROCESS_BOUNDARY_POINTER_PAYLOAD_DETAIL
          : RESERVED_EXTERNAL_PAYLOAD_DETAIL,
      });
    }

    let text: string | undefined;
    try {
      text = stringifyJSON([
        codecId,
        trustedReservedCodec
          ? readTrustedExternalPayloadMetadata(externalPayload)
          : externalPayload.toMetadata(),
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail,
      });
    }
    if (typeof text !== "string") {
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: "External payload metadata must be JSON serializable.",
      });
    }

    if (text.length <= staticMaxBytes) {
      const written = writeStaticUtf8(text, slotIndex);
      if (written !== -1) {
        task[TaskIndex.Type] = PayloadBuffer.StaticExternalPayload;
        task[TaskIndex.PayloadLen] = written;
        attachPayloadTransportFinalizer(task, externalPayload);
        task.value = null;
        return true;
      }
    }

    task[TaskIndex.Type] = PayloadBuffer.ExternalPayload;
    const reserveBytes = dynamicUtf8ReserveBytes(
      task,
      text,
      "ExternalPayload",
    );
    if (reserveBytes < 0) return false;
    const reservedSlot = reserveDynamicObject(task, reserveBytes);
    if (reservedSlot === -1) return false;
    const written = writeDynamicUtf8(
      text,
      task[TaskIndex.Start],
      reserveBytes,
    );
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
    attachPayloadTransportFinalizer(task, externalPayload);
    task.value = null;
    return true;
  };
  /** Encode plain objects, arrays, and null-prototype objects as JSON. */
  const encodeObjectJson = (
    task: Task,
    slotIndex: number,
    objectValue: object,
  ): boolean => {
    let text: string;
    try {
      text = stringifyJSON(objectValue);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return encoderError({
        task,
        type: ErrorKnitting.Json,
        onPromise,
        detail,
      });
    }
    if (text.length <= staticMaxBytes) {
      const written = writeStaticUtf8(text, slotIndex);
      if (written !== -1) {
        task[TaskIndex.Type] = PayloadBuffer.StaticJson;
        task[TaskIndex.PayloadLen] = written;
        // Retain any transport-owned memory until the call settles.
        attachPayloadTransportFinalizer(task, objectValue);
        task.value = null;
        return true;
      }
    }

    task[TaskIndex.Type] = PayloadBuffer.Json;
    const reserveBytes = dynamicUtf8ReserveBytes(task, text, "Json");
    if (reserveBytes < 0) return false;
    const reservedSlot = reserveDynamicObject(task, reserveBytes);
    if (reservedSlot === -1) return false;
    const written = writeDynamicUtf8(
      text,
      task[TaskIndex.Start],
      reserveBytes,
    );
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
    attachPayloadTransportFinalizer(task, objectValue);
    task.value = null;
    return true;
  };

  const encodeObjectDate = (task: Task, date: Date) => {
    Float64View[0] = date.getTime();
    task[TaskIndex.Type] = PayloadBuffer.Date;
    task[TaskIndex.Start] = Uint32View[0];
    task[TaskIndex.End] = Uint32View[1];
    task.value = null;
    return true;
  };
  const encodeEnvelopeHeaderText = (
    task: Task,
    header: unknown,
    headerIsString: boolean,
  ): string | undefined => {
    if (hasPromiseInEnvelopeHeader(header)) {
      encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: ENVELOPE_PROMISE_DETAIL,
      });
      return undefined;
    }
    if (headerIsString) return header as string;
    let headerText: string | undefined;
    try {
      headerText = stringifyJSON(header);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      encoderError({ task, type: ErrorKnitting.Json, onPromise, detail });
      return undefined;
    }
    if (typeof headerText !== "string") {
      encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: ENVELOPE_HEADER_DETAIL,
      });
      return undefined;
    }
    return headerText;
  };

  const resolveEnvelopeExternalBody = (
    body: unknown,
  ):
    | { payload: ExternalPayloadLike; trustedReservedCodec: boolean }
    | undefined => {
    if (body === null || typeof body !== "object") return undefined;
    const sharedArrayBuffer = getSharedArrayBufferPayload(body as object);
    if (sharedArrayBuffer !== undefined) {
      return { payload: sharedArrayBuffer, trustedReservedCodec: true };
    }
    if (
      isBufferReferenceValue(body) ||
      isProcessSharedBufferValue(body)
    ) {
      return {
        payload: body as ExternalPayloadLike,
        trustedReservedCodec: true,
      };
    }
    if (isExternalPayloadLike(body as object)) {
      return {
        payload: body as ExternalPayloadLike,
        trustedReservedCodec: false,
      };
    }
    return undefined;
  };

  const encodeEnvelopeArrayBufferBody = (
    task: Task,
    slotIndex: number,
    headerText: string,
    headerIsString: boolean,
    payload: ArrayBuffer,
  ) => {
    const payloadBytes = new Uint8Array(payload);
    const payloadLength = payloadBytes.byteLength;
    const payloadReserveBytes = payloadLength > 0 ? payloadLength : 1;

    const staticHeaderWritten = writeStaticUtf8(headerText, slotIndex);
    if (staticHeaderWritten !== -1) {
      if (
        !ensureWithinDynamicLimit(
          task,
          payloadReserveBytes,
          "EnvelopeStaticHeaderPayload",
        )
      ) return false;
      const reservedSlot = reserveDynamicObject(task, payloadReserveBytes);
      if (reservedSlot === -1) return false;
      task[TaskIndex.Type] = headerIsString
        ? PayloadBuffer.EnvelopeStaticHeaderString
        : PayloadBuffer.EnvelopeStaticHeader;
      task[TaskIndex.PayloadLen] = staticHeaderWritten;
      task[TaskIndex.End] = payloadLength;
      if (payloadLength > 0) {
        const payloadWritten = writeDynamicBinary(
          payloadBytes,
          task[TaskIndex.Start],
        );
        if (payloadWritten < 0) {
          return failDynamicWriteAfterReserve(task, reservedSlot);
        }
        setSlotLength(reservedSlot, payloadWritten);
      } else {
        setSlotLength(reservedSlot, 0);
      }
      task.value = null;
      tagTaskSlot(task, reservedSlot);
      return true;
    }

    const headerReserveBytes = dynamicUtf8ReserveBytesWithExtra(
      task,
      headerText,
      payloadLength,
      headerIsString ? "EnvelopeDynamicHeaderString" : "EnvelopeDynamicHeader",
    );
    if (headerReserveBytes < 0) return false;
    task[TaskIndex.Type] = headerIsString
      ? PayloadBuffer.EnvelopeDynamicHeaderString
      : PayloadBuffer.EnvelopeDynamicHeader;
    const reservedSlot = reserveDynamicObject(
      task,
      headerReserveBytes + payloadLength,
    );
    if (reservedSlot === -1) return false;
    const baseStart = task[TaskIndex.Start];
    const writtenHeaderBytes = writeDynamicUtf8(
      headerText,
      baseStart,
      headerReserveBytes,
    );
    if (writtenHeaderBytes < 0) {
      return failDynamicWriteAfterReserve(task, reservedSlot);
    }
    if (payloadLength > 0) {
      const payloadWritten = writeDynamicBinary(
        payloadBytes,
        baseStart + writtenHeaderBytes,
      );
      if (payloadWritten < 0) {
        return failDynamicWriteAfterReserve(task, reservedSlot);
      }
    }
    task[TaskIndex.PayloadLen] = writtenHeaderBytes;
    task[TaskIndex.End] = payloadLength;
    setSlotLength(
      reservedSlot,
      writtenHeaderBytes + payloadLength,
    );
    task.value = null;
    tagTaskSlot(task, reservedSlot);
    return true;
  };

  const encodeEnvelopeExternalBody = (
    task: Task,
    slotIndex: number,
    headerText: string,
    headerIsString: boolean,
    externalBody: ExternalPayloadLike,
    trustedReservedCodec: boolean,
  ) => {
    const codecId = readExternalPayloadCodecId(externalBody as object);
    if (codecId === undefined) {
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: ENVELOPE_PAYLOAD_DETAIL,
      });
    }
    if (trustedReservedCodec) {
      if (processBoundary && isProcessLocalPointerCodec(codecId)) {
        return encoderError({
          task,
          type: ErrorKnitting.Serializable,
          onPromise,
          detail: PROCESS_BOUNDARY_POINTER_PAYLOAD_DETAIL,
        });
      }
    } else if (isReservedExternalPayloadCodec(codecId)) {
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: processBoundary && isProcessLocalPointerCodec(codecId)
          ? PROCESS_BOUNDARY_POINTER_PAYLOAD_DETAIL
          : RESERVED_EXTERNAL_PAYLOAD_DETAIL,
      });
    }

    let bodyText: string | undefined;
    try {
      bodyText = stringifyJSON([
        codecId,
        trustedReservedCodec
          ? readTrustedExternalPayloadMetadata(externalBody)
          : externalBody.toMetadata(),
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail,
      });
    }
    if (typeof bodyText !== "string") {
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: "Envelope body metadata must be JSON serializable.",
      });
    }

    const bodyBytes = textEncode.encode(bodyText);
    const bodyLength = bodyBytes.byteLength;

    const staticHeaderWritten = writeStaticUtf8(headerText, slotIndex);
    if (staticHeaderWritten !== -1) {
      if (
        !ensureWithinDynamicLimit(
          task,
          bodyLength,
          "EnvelopeStaticHeaderExternal",
        )
      ) return false;
      const reservedSlot = reserveDynamicObject(task, bodyLength);
      if (reservedSlot === -1) return false;
      task[TaskIndex.Type] = headerIsString
        ? PayloadBuffer.EnvelopeStaticHeaderStringExternal
        : PayloadBuffer.EnvelopeStaticHeaderExternal;
      task[TaskIndex.PayloadLen] = staticHeaderWritten;
      task[TaskIndex.End] = bodyLength;
      const bodyWritten = writeDynamicBinary(bodyBytes, task[TaskIndex.Start]);
      if (bodyWritten < 0) {
        return failDynamicWriteAfterReserve(task, reservedSlot);
      }
      setSlotLength(reservedSlot, bodyWritten);
      attachPayloadTransportFinalizer(task, externalBody);
      task.value = null;
      tagTaskSlot(task, reservedSlot);
      return true;
    }

    const headerReserveBytes = dynamicUtf8ReserveBytesWithExtra(
      task,
      headerText,
      bodyLength,
      headerIsString
        ? "EnvelopeDynamicHeaderStringExternal"
        : "EnvelopeDynamicHeaderExternal",
    );
    if (headerReserveBytes < 0) return false;
    task[TaskIndex.Type] = headerIsString
      ? PayloadBuffer.EnvelopeDynamicHeaderStringExternal
      : PayloadBuffer.EnvelopeDynamicHeaderExternal;
    const reservedSlot = reserveDynamicObject(
      task,
      headerReserveBytes + bodyLength,
    );
    if (reservedSlot === -1) return false;
    const baseStart = task[TaskIndex.Start];
    const writtenHeaderBytes = writeDynamicUtf8(
      headerText,
      baseStart,
      headerReserveBytes,
    );
    if (writtenHeaderBytes < 0) {
      return failDynamicWriteAfterReserve(task, reservedSlot);
    }
    const bodyWritten = writeDynamicBinary(
      bodyBytes,
      baseStart + writtenHeaderBytes,
    );
    if (bodyWritten < 0) {
      return failDynamicWriteAfterReserve(task, reservedSlot);
    }
    task[TaskIndex.PayloadLen] = writtenHeaderBytes;
    task[TaskIndex.End] = bodyLength;
    setSlotLength(reservedSlot, writtenHeaderBytes + bodyLength);
    attachPayloadTransportFinalizer(task, externalBody);
    task.value = null;
    tagTaskSlot(task, reservedSlot);
    return true;
  };

  const encodeObjectEnvelope = (
    task: Task,
    slotIndex: number,
    envelope: Envelope,
  ) => {
    const header = envelope.header;
    const payload = envelope.payload;
    const headerIsString = typeof header === "string";

    if (payload instanceof ArrayBuffer) {
      const headerText = encodeEnvelopeHeaderText(task, header, headerIsString);
      if (headerText === undefined) return false;
      return encodeEnvelopeArrayBufferBody(
        task,
        slotIndex,
        headerText,
        headerIsString,
        payload,
      );
    }

    const externalBody = resolveEnvelopeExternalBody(payload);
    if (externalBody !== undefined) {
      const headerText = encodeEnvelopeHeaderText(task, header, headerIsString);
      if (headerText === undefined) return false;
      return encodeEnvelopeExternalBody(
        task,
        slotIndex,
        headerText,
        headerIsString,
        externalBody.payload,
        externalBody.trustedReservedCodec,
      );
    }

    return encoderError({
      task,
      type: ErrorKnitting.Serializable,
      onPromise,
      detail: ENVELOPE_PAYLOAD_DETAIL,
    });
  };
  const encodeObjectPromise = (task: Task, promise: Promise<unknown>) => {
    if (beginPromisePayload(task)) {
      promise.then(
        (value) => {
          finishPromisePayload(task);
          task.value = value;
          onPromise!(task, false, value);
        },
        (reason) => {
          finishPromisePayload(task);
          task.value = reason;
          onPromise!(task, true, reason);
        },
      );
    }
    return false;
  };

  // Named function so V8/TurboFan can compile it independently from the
  // encodePayload factory closure. Anonymous returns prevent full optimization
  // because the outer factory is too large for TurboFan's bytecode limit.
  const encodeDispatch = (task: Task, slotIndex: number): boolean => {
    const args = task.value;
    if (tryEncodePrimitiveTask(task)) return true;
    switch (typeof args) {
      case "bigint": {
        const binaryBytes = encodeBigIntIntoScratch(args);
        const binary = bigintScratch.subarray(0, binaryBytes);
        if (binaryBytes <= staticMaxBytes) {
          const written = writeStaticBinary(binary, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticBigInt;
            task[TaskIndex.PayloadLen] = written;
            clearBigIntScratch(binaryBytes);
            task.value = null;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.BigInt;
        if (!ensureWithinDynamicLimit(task, binaryBytes, "BigInt")) {
          clearBigIntScratch(binaryBytes);
          return false;
        }
        const reservedSlot = reserveDynamic(task, binaryBytes);
        if (reservedSlot === -1) {
          clearBigIntScratch(binaryBytes);
          return false;
        }
        const written = writeDynamicBinary(binary, task[TaskIndex.Start]);
        if (written < 0) {
          clearBigIntScratch(binaryBytes);
          return failDynamicWriteAfterReserve(task, reservedSlot);
        }
        task[TaskIndex.PayloadLen] = written;
        setSlotLength(reservedSlot, written);
        clearBigIntScratch(binaryBytes);
        task.value = null;
        return true;
      }
      case "function":
        return encoderError({
          task,
          type: ErrorKnitting.Function,
          onPromise,
        });
      case "object":
        objectDynamicSlot = -1;

        try {
          const objectValue = args as object;
          const objectProto = objectGetPrototypeOf(objectValue);

          // Plain objects can skip the typed-array and external-payload checks.
          if (objectProto === objectPrototype) {
            return encodeObjectJson(task, slotIndex, objectValue);
          }

          const sharedArrayBufferPayload = getSharedArrayBufferPayload(
            objectValue,
          );
          if (sharedArrayBufferPayload !== undefined) {
            return encodeObjectExternalPayload(
              task,
              slotIndex,
              sharedArrayBufferPayload,
              true,
            );
          }

          if (isRuntimeUint8Array(objectValue)) {
            return encodeObjectUint8Array(
              task,
              slotIndex,
              objectValue as Uint8Array,
            );
          }

          if (arrayIsArray(objectValue) && isNumericArray(objectValue)) {
            return encodeObjectNumericArray(
              task,
              slotIndex,
              objectValue as NumericArray,
            );
          }

          if (arrayIsArray(objectValue) || objectProto === null) {
            return encodeObjectJson(task, slotIndex, objectValue);
          }

          if (
            isBufferReferenceValue(objectValue) ||
            isProcessSharedBufferValue(objectValue)
          ) {
            return encodeObjectExternalPayload(
              task,
              slotIndex,
              objectValue as ExternalPayloadLike,
              true,
            );
          }

          const objectCtor = (objectValue as { constructor?: unknown })
            .constructor;

          if (isRuntimeBuffer(objectValue)) {
            return encodeObjectBuffer(
              task,
              slotIndex,
              objectValue,
            );
          }

          switch (objectCtor) {
            case ArrayBuffer:
              return encodeObjectArrayBuffer(
                task,
                slotIndex,
                objectValue as ArrayBuffer,
              );
            case Int32Array: {
              const int32 = objectValue as Int32Array;
              return encodeObjectBinary(
                task,
                slotIndex,
                new Uint8Array(
                  int32.buffer,
                  int32.byteOffset,
                  int32.byteLength,
                ),
                PayloadBuffer.Int32Array,
                PayloadBuffer.StaticInt32Array,
              );
            }
            case Float64Array:
              return encodeObjectFloat64Array(
                task,
                slotIndex,
                objectValue as Float64Array,
              );
            case BigInt64Array: {
              const bigInt64 = objectValue as BigInt64Array;
              return encodeObjectBinary(
                task,
                slotIndex,
                new Uint8Array(
                  bigInt64.buffer,
                  bigInt64.byteOffset,
                  bigInt64.byteLength,
                ),
                PayloadBuffer.BigInt64Array,
                PayloadBuffer.StaticBigInt64Array,
              );
            }
            case BigUint64Array: {
              const bigUint64 = objectValue as BigUint64Array;
              return encodeObjectBinary(
                task,
                slotIndex,
                new Uint8Array(
                  bigUint64.buffer,
                  bigUint64.byteOffset,
                  bigUint64.byteLength,
                ),
                PayloadBuffer.BigUint64Array,
                PayloadBuffer.StaticBigUint64Array,
              );
            }
            case DataView: {
              const dataView = objectValue as DataView;
              return encodeObjectBinary(
                task,
                slotIndex,
                new Uint8Array(
                  dataView.buffer,
                  dataView.byteOffset,
                  dataView.byteLength,
                ),
                PayloadBuffer.DataView,
                PayloadBuffer.StaticDataView,
              );
            }
            case Date:
              return encodeObjectDate(task, objectValue as Date);
            case Envelope:
              return encodeObjectEnvelope(
                task,
                slotIndex,
                objectValue as Envelope,
              );
            case Promise:
              return encodeObjectPromise(task, objectValue as Promise<unknown>);
            case Error:
              return encodeErrorObject(task, objectValue as Error);
          }

          if (objectValue instanceof Date) {
            return encodeObjectDate(task, objectValue);
          }
          if (objectValue instanceof Envelope) {
            return encodeObjectEnvelope(task, slotIndex, objectValue);
          }
          if (objectValue instanceof Promise) {
            return encodeObjectPromise(task, objectValue);
          }
          if (objectValue instanceof Error) {
            return encodeErrorObject(task, objectValue);
          }
          if (isExternalPayloadLike(objectValue)) {
            return encodeObjectExternalPayload(
              task,
              slotIndex,
              objectValue,
            );
          }

          return encoderError({
            task,
            type: ErrorKnitting.Serializable,
            onPromise,
            detail: UNSUPPORTED_OBJECT_DETAIL,
          });
        } catch (error) {
          rollbackObjectDynamic();
          const detail = error instanceof Error ? error.message : String(error);
          return encoderError({
            task,
            type: ErrorKnitting.Serializable,
            onPromise,
            detail,
          });
        }
      case "string": {
        const text = args as string;
        if (text.length <= staticMaxBytes) {
          const written = writeStaticUtf8(text, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticString;
            task[TaskIndex.PayloadLen] = written;
            task.value = null;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.String;
        const reserveBytes = dynamicUtf8ReserveBytes(task, text, "String");
        if (reserveBytes < 0) return false;
        const reservedSlot = reserveDynamic(task, reserveBytes);
        if (reservedSlot === -1) return false;

        const written = writeDynamicUtf8(
          text,
          task[TaskIndex.Start],
          reserveBytes,
        );
        if (written < 0) {
          return failDynamicWriteAfterReserve(task, reservedSlot);
        }
        task[TaskIndex.PayloadLen] = written;
        setSlotLength(reservedSlot, written);
        task.value = null;
        return true;
      }
      case "symbol": {
        const key = symbolKeyFor(args);
        if (key === undefined) {
          return encoderError({
            task,
            type: ErrorKnitting.Symbol,
            onPromise,
          });
        }
        if (key.length * 3 <= staticMaxBytes) {
          const written = writeStaticUtf8(key, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticSymbol;
            task[TaskIndex.PayloadLen] = written;
            task.value = null;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.Symbol;
        const reserveBytes = dynamicUtf8ReserveBytes(task, key, "Symbol");
        if (reserveBytes < 0) return false;
        const reservedSlot = reserveDynamic(task, reserveBytes);
        if (reservedSlot === -1) return false;
        const written = writeDynamicUtf8(
          key,
          task[TaskIndex.Start],
          reserveBytes,
        );
        if (written < 0) {
          return failDynamicWriteAfterReserve(task, reservedSlot);
        }
        task[TaskIndex.PayloadLen] = written;
        setSlotLength(reservedSlot, written);
        task.value = null;
        return true;
      }
    }
    return false;
  };

  return encodeDispatch;
};

export const decodePayload = ({
  lockSector,
  payload,
  sab,
  payloadConfig,
  headersBuffer,
  headerSlotStrideU32,
  textCompat,
  host,
  processBoundary = false,
}: {
  lockSector?: SharedBufferSource;
  payload?: {
    sab?: SharedBufferSource;
    config?: PayloadBufferOptions;
  };
  /**
   * @deprecated Use `payload.sab`.
   */
  sab?: SharedBufferSource;
  /**
   * @deprecated Use `payload.config`.
   */
  payloadConfig?: PayloadBufferOptions;
  headersBuffer: Uint32Array;
  headerSlotStrideU32?: number;
  textCompat?: LockBufferTextCompat;
  host?: true;
  /**
   * Reject process-local pointer payloads before reading pointer/token metadata.
   */
  processBoundary?: boolean;
}) => {
  const payloadSab = payload?.sab ?? sab;
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payloadSab,
    options: payload?.config ?? payloadConfig,
  });
  const { free } = register({ lockSector });
  // Region identity is 6 bits only for dynamic payloads. Its high bit rides in
  // End's otherwise-unused top bit, preserving the 5-bit queue-slot field.
  const freeTaskSlot = (task: Task) => free(
    (task[TaskIndex.slotBuffer] & TASK_SLOT_INDEX_MASK) |
      ((task[TaskIndex.End] >>> 31) << 5),
  );
  const {
    readUtf8: readDynamicUtf8,
    readBytesCopy: readDynamicBytesCopy,
    readBytesBufferCopy: readDynamicBufferCopy,
    readBufferCopy: readDynamicBuffer,
    readBytesArrayBufferCopy: readDynamicArrayBufferCopy,
    readArrayBufferCopy: readDynamicArrayBuffer,
    read8BytesFloatCopy: readDynamic8BytesFloatCopy,
    read8BytesFloatView: readDynamic8BytesFloatView,
    readBytesView: readDynamicBytesView,
    syncGrowth: syncDynamicGrowth,
  } = createSharedDynamicBufferIO({
    sab: payloadSab,
    payloadConfig: resolvedPayloadConfig,
    textCompat: textCompat?.payload,
  });
  const {
    readUtf8: readStaticUtf8,
    readBytesBufferCopy: readStaticBufferCopy,
    readBufferCopy: readStaticBuffer,
    readUint8ArrayCopy: readStaticUint8ArrayCopy,
    readBytesArrayBufferCopy: readStaticArrayBufferCopy,
    readArrayBufferCopy: readStaticArrayBuffer,
    read8BytesFloatCopy: readStatic8BytesFloatCopy,
    readU32Words: readStaticU32Words,
  } = requireStaticIO(
    headersBuffer,
    headerSlotStrideU32,
    textCompat?.headers,
  );
  // Reusable scratch for the ProcessSharedBuffer raw-word decode. Safe to share:
  // decode is single-consumer and not re-entrant, and the words are consumed
  // synchronously when building the ProcessSharedBuffer.
  const processSharedBufferWords = new Uint32Array(
    PROCESS_SHARED_BUFFER_NUMERIC_WORDS,
  );
  const sharedArrayBufferWords = new Uint32Array(
    SHARED_ARRAY_BUFFER_NUMERIC_WORDS,
  );
  // `readStaticU32Words` returns the whole scratch, and the SAB codec dispatches
  // on word count, so hand it a view cut to the frame's own length.
  const sharedArrayBufferWordViews: Uint32Array[] = [];
  for (let count = 0; count <= SHARED_ARRAY_BUFFER_NUMERIC_WORDS; count++) {
    sharedArrayBufferWordViews.push(sharedArrayBufferWords.subarray(0, count));
  }
  const bufferReferenceWords = new Uint32Array(BUFFER_REFERENCE_NUMERIC_WORDS);

  return (task: Task, slotIndex: number, specialFlags?: number) => {
    const payloadType = task[TaskIndex.Type];
    if (
      processBoundary &&
      (
        payloadType === PayloadBuffer.SharedArrayBuffer ||
        payloadType === PayloadBuffer.BufferReference
      )
    ) {
      throw new TypeError(PROCESS_BOUNDARY_POINTER_PAYLOAD_DETAIL);
    }

    switch (payloadType) {
      case PayloadSignal.BigInt:
        Uint32View[0] = task[TaskIndex.Start];
        Uint32View[1] = task[TaskIndex.End];
        task.value = BigInt64View[0];
        return;
      case PayloadSignal.True:
        task.value = true;
        return;
      case PayloadSignal.False:
        task.value = false;
        return;
      case PayloadSignal.Float64:
        Uint32View[0] = task[TaskIndex.Start];
        Uint32View[1] = task[TaskIndex.End];
        task.value = Float64View[0];
        return;
      case PayloadSignal.NaN:
        task.value = NaN;
        return;
      case PayloadSignal.Null:
        task.value = null;
        return;
      case PayloadSignal.Undefined:
        task.value = undefined;
        return;
      case PayloadBuffer.String:
        task.value = readDynamicUtf8(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        );
        freeTaskSlot(task);
        return;
      case PayloadBuffer.StaticString:
        task.value = readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex);
        return;
      case PayloadBuffer.Json:
        task.value = parseJSON(
          readDynamicUtf8(
            task[TaskIndex.Start],
            task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
          ),
        );
        freeTaskSlot(task);
        return;
      case PayloadBuffer.StaticJson:
        task.value = parseJSON(
          readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex),
        );
        return;
      case PayloadBuffer.EnvelopeStaticHeader:
      case PayloadBuffer.EnvelopeStaticHeaderString: {
        const rawHeader = readStaticUtf8(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        const header =
          task[TaskIndex.Type] === PayloadBuffer.EnvelopeStaticHeaderString
            ? rawHeader
            : parseJSON(rawHeader);
        const payloadLength = task[TaskIndex.End] & 0x7FFFFFFF;
        const payload = payloadLength > 0
          ? readDynamicArrayBufferCopy(
            task[TaskIndex.Start],
            task[TaskIndex.Start] + payloadLength,
          )
          : new ArrayBuffer(0);
        task.value = new Envelope(header as any, payload);
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.EnvelopeDynamicHeader:
      case PayloadBuffer.EnvelopeDynamicHeaderString: {
        const headerStart = task[TaskIndex.Start];
        const payloadStart = headerStart + task[TaskIndex.PayloadLen];
        const payloadLength = task[TaskIndex.End] & 0x7FFFFFFF;
        const rawHeader = readDynamicUtf8(headerStart, payloadStart);
        const header =
          task[TaskIndex.Type] === PayloadBuffer.EnvelopeDynamicHeaderString
            ? rawHeader
            : parseJSON(rawHeader);
        const payload = payloadLength > 0
          ? readDynamicArrayBufferCopy(
            payloadStart,
            payloadStart + payloadLength,
          )
          : new ArrayBuffer(0);
        task.value = new Envelope(header as any, payload);
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.EnvelopeStaticHeaderExternal:
      case PayloadBuffer.EnvelopeStaticHeaderStringExternal: {
        const rawHeader = readStaticUtf8(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        const header = task[TaskIndex.Type] ===
            PayloadBuffer.EnvelopeStaticHeaderStringExternal
          ? rawHeader
          : parseJSON(rawHeader);
        const bodyStart = task[TaskIndex.Start];
        const body = decodeExternalPayload(
          readDynamicUtf8(
            bodyStart,
            bodyStart + (task[TaskIndex.End] & 0x7FFFFFFF),
          ),
          processBoundary,
        );
        task.value = new Envelope(header as any, body as any);
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.EnvelopeDynamicHeaderExternal:
      case PayloadBuffer.EnvelopeDynamicHeaderStringExternal: {
        const headerStart = task[TaskIndex.Start];
        const bodyStart = headerStart + task[TaskIndex.PayloadLen];
        const rawHeader = readDynamicUtf8(headerStart, bodyStart);
        const header = task[TaskIndex.Type] ===
            PayloadBuffer.EnvelopeDynamicHeaderStringExternal
          ? rawHeader
          : parseJSON(rawHeader);
        const body = decodeExternalPayload(
          readDynamicUtf8(
            bodyStart,
            bodyStart + (task[TaskIndex.End] & 0x7FFFFFFF),
          ),
          processBoundary,
        );
        task.value = new Envelope(header as any, body as any);
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.BigInt:
        task.value = decodeBigIntBinary(
          readDynamicBufferCopy(
            task[TaskIndex.Start],
            task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
          ),
        );
        freeTaskSlot(task);
        return;
      case PayloadBuffer.StaticBigInt:
        task.value = decodeBigIntBinary(
          readStaticBufferCopy(0, task[TaskIndex.PayloadLen], slotIndex),
        );
        return;
      case PayloadBuffer.Symbol:
        task.value = symbolFor(
          readDynamicUtf8(
            task[TaskIndex.Start],
            task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
          ),
        );
        freeTaskSlot(task);
        return;
      case PayloadBuffer.StaticSymbol:
        task.value = symbolFor(
          readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex),
        );
        return;
      case PayloadBuffer.Int32Array: {
        const bytes = readDynamicBufferCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        );
        task.value = new Int32Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength >>> 2,
        );
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.StaticInt32Array: {
        const bytes = readStaticBufferCopy(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        task.value = new Int32Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength >>> 2,
        );
        return;
      }
      case PayloadBuffer.Float64Array: {
        task.value = readDynamic8BytesFloatCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        );
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.StaticFloat64Array:
        task.value = readStatic8BytesFloatCopy(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        return;
      case PayloadBuffer.NumericArray: {
        task.value = numericArrayFromFloat64(
          readDynamic8BytesFloatView(
            task[TaskIndex.Start],
            task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
          ),
        );
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.StaticNumericArray:
        task.value = numericArrayFromFloat64(
          readStatic8BytesFloatCopy(0, task[TaskIndex.PayloadLen], slotIndex),
        );
        return;
      case PayloadBuffer.BigInt64Array: {
        const bytes = readDynamicBufferCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        );
        task.value = new BigInt64Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength >>> 3,
        );
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.StaticBigInt64Array: {
        const bytes = readStaticBufferCopy(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        task.value = new BigInt64Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength >>> 3,
        );
        return;
      }
      case PayloadBuffer.BigUint64Array: {
        const bytes = readDynamicBufferCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        );
        task.value = new BigUint64Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength >>> 3,
        );
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.StaticBigUint64Array: {
        const bytes = readStaticBufferCopy(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        task.value = new BigUint64Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength >>> 3,
        );
        return;
      }
      case PayloadBuffer.DataView: {
        const bytes = readDynamicBufferCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        );
        task.value = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        freeTaskSlot(task);
        return;
      }
      case PayloadBuffer.StaticDataView: {
        const bytes = readStaticBufferCopy(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        task.value = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        return;
      }
      case PayloadBuffer.ExternalPayload:
        task.value = decodeExternalPayload(
          readDynamicUtf8(
            task[TaskIndex.Start],
            task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
          ),
          processBoundary,
          lockSector as object | undefined,
        );
        freeTaskSlot(task);
        return;
      case PayloadBuffer.StaticExternalPayload:
        task.value = decodeExternalPayload(
          readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex),
          processBoundary,
          lockSector as object | undefined,
        );
        return;
      case PayloadBuffer.ProcessSharedBuffer:
        task.value = decodeProcessSharedBufferNumericWords(
          readStaticU32Words(
            processSharedBufferWords,
            PROCESS_SHARED_BUFFER_NUMERIC_WORDS,
            slotIndex,
          ),
        );
        return;
      case PayloadBuffer.SharedArrayBuffer: {
        const wordCount = task[TaskIndex.PayloadLen] >>> 2;
        task.value = decodeSharedArrayBufferNumericWords(
          readStaticU32Words(
            sharedArrayBufferWordViews[wordCount] ?? sharedArrayBufferWords,
            wordCount,
            slotIndex,
          ),
          lockSector as object | undefined,
        );
        return;
      }
      case PayloadBuffer.BufferReference:
        task.value = decodeBufferReferenceNumericWords(
          readStaticU32Words(
            bufferReferenceWords,
            BUFFER_REFERENCE_NUMERIC_WORDS,
            slotIndex,
          ),
        );
        return;
      case PayloadBuffer.MovedBinary: {
        const reference = decodeBufferReferenceNumericWords(
          readStaticU32Words(
            bufferReferenceWords,
            BUFFER_REFERENCE_NUMERIC_WORDS,
            slotIndex,
          ),
        );
        if (!isBufferReferenceValue(reference)) {
          throw new TypeError("Invalid moved Uint8Array payload");
        }
        task.value = reference.toUint8Array();
        return;
      }
      case PayloadBuffer.MovedArrayBuffer: {
        const reference = decodeBufferReferenceNumericWords(
          readStaticU32Words(
            bufferReferenceWords,
            BUFFER_REFERENCE_NUMERIC_WORDS,
            slotIndex,
          ),
        );
        if (!isBufferReferenceValue(reference)) {
          throw new TypeError("Invalid moved ArrayBuffer payload");
        }
        task.value = reference.toArrayBuffer();
        return;
      }
      case PayloadBuffer.Date:
        Uint32View[0] = task[TaskIndex.Start];
        Uint32View[1] = task[TaskIndex.End];
        task.value = new Date(Float64View[0]);
        return;
      case PayloadBuffer.Error:
        task.value = parseErrorPayload(
          readDynamicUtf8(
            task[TaskIndex.Start],
            task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
          ),
        );
        freeTaskSlot(task);
        return;
      // Borrowed region: decode a view into the shared arena.
      case PayloadBuffer.ArenaBinary:
        // A borrowed region can sit past the length this endpoint last saw.
        syncDynamicGrowth();
        task.value = readDynamicBytesView(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        );
        return;
      case PayloadBuffer.Binary:
        {
          const buffer = readDynamicBufferCopy(
            task[TaskIndex.Start],
            task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
          );
          task.value = new Uint8Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength,
          );
        }
        freeTaskSlot(task);
        return;
      case PayloadBuffer.StaticBinary:
        task.value = readStaticUint8ArrayCopy(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        return;
      case PayloadBuffer.ArrayBuffer:
        task.value = readDynamicArrayBuffer(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        );
        freeTaskSlot(task);
        return;
      case PayloadBuffer.StaticArrayBuffer:
        task.value = readStaticArrayBuffer(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        return;
      case PayloadBuffer.Buffer:
        task.value = readDynamicBuffer(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        );
        freeTaskSlot(task);
        return;
      case PayloadBuffer.StaticBuffer:
        task.value = readStaticBuffer(
          0,
          task[TaskIndex.PayloadLen],
          slotIndex,
        );
        return;
    }
  };
};

// Break the lock.ts <-> payloadCodec.ts cycle (see lock.ts): register the codec
// factories on load instead of having lock.ts import them.
registerLockPayloadCodec(encodePayload, decodePayload);
