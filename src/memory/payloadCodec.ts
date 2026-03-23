import {
  beginPromisePayload,
  finishPromisePayload,
  getTaskSlotIndex,
  HEADER_BYTE_LENGTH,
  HEADER_SLOT_STRIDE_U32,
  HEADER_STATIC_PAYLOAD_U32,
  LockBound,
  PayloadBuffer,
  PayloadSignal,
  type PromisePayloadHandler,
  type Task,
  TaskIndex,
} from "./lock.ts";
import { register } from "./regionRegistry.ts";
import {
  createSharedDynamicBufferIO,
  createSharedStaticBufferIO,
} from "./createSharedBufferIO.ts";
import { getStridedRegionSpanBytes } from "./byte-carpet.ts";
import { IS_BROWSER } from "../common/runtime.ts";
import { encoderError, ErrorKnitting } from "../error.ts";
import { Envelope } from "../common/envelope.ts";
import type { LockBufferTextCompat } from "../common/shared-buffer-text.ts";
import {
  type PayloadBufferOptions,
  resolvePayloadBufferOptions,
} from "./payload-config.ts";
import type { SharedBufferSource } from "../common/shared-buffer-region.ts";

const memory = new ArrayBuffer(8);
const Float64View = new Float64Array(memory);
const BigInt64View = new BigInt64Array(memory);
const Uint32View = new Uint32Array(memory);
const textEncode = new TextEncoder();
const runtimeBufferClass = (IS_BROWSER ? undefined : (globalThis as typeof globalThis & {
  Buffer?: {
    byteLength?: (value: string, encoding?: string) => number;
    isBuffer?: (candidate: unknown) => boolean;
  };
}).Buffer);
const runtimeBufferByteLength = !IS_BROWSER &&
    typeof runtimeBufferClass?.byteLength === "function"
  ? runtimeBufferClass.byteLength.bind(runtimeBufferClass)
  : undefined;
const isRuntimeBuffer = (value: unknown): value is Uint8Array =>
  !IS_BROWSER &&
  typeof runtimeBufferClass?.isBuffer === "function" &&
  runtimeBufferClass.isBuffer(value);
const isRuntimeUint8Array: (value: unknown) => value is Uint8Array = IS_BROWSER
  ? ((value: unknown): value is Uint8Array => value instanceof Uint8Array)
  : ((value: unknown): value is Uint8Array =>
    value != null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Uint8Array.prototype);
const utf8ByteLength = IS_BROWSER || !runtimeBufferByteLength
  ? (text: string): number => textEncode.encode(text).byteLength
  : (text: string): number => runtimeBufferByteLength(text, "utf8");
const BIGINT64_MIN = -(1n << 63n);
const BIGINT64_MAX = (1n << 63n) - 1n;
const { parse: parseJSON, stringify: stringifyJSON } = JSON;
const { for: symbolFor, keyFor: symbolKeyFor } = Symbol;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.prototype.hasOwnProperty;
const arrayIsArray = Array.isArray;
const objectPrototype = Object.prototype;
const UNSUPPORTED_OBJECT_DETAIL =
  "Unsupported object type. Allowed: plain object, array, Error, Date, Envelope, Buffer, ArrayBuffer, DataView, and typed arrays. Serialize it yourself.";
const ENVELOPE_PAYLOAD_DETAIL = "Envelope payload must be an ArrayBuffer.";
const ENVELOPE_HEADER_DETAIL =
  "Envelope header must be a JSON-like value or string.";
const ENVELOPE_PROMISE_DETAIL =
  "Envelope header cannot contain Promise values.";
const DYNAMIC_PAYLOAD_LIMIT_DETAIL = "Dynamic payload exceeds maxPayloadBytes.";
const DYNAMIC_PAYLOAD_CAPACITY_DETAIL =
  "Dynamic payload buffer capacity exceeded.";

const isPlainJsonObject = (value: object) => {
  const proto = objectGetPrototypeOf(value);
  return proto === objectPrototype || proto === null;
};

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
}: {
  lockSector?: SharedBufferSource;
  payload?: {
    sab?: SharedArrayBuffer;
    config?: PayloadBufferOptions;
  };
  /**
   * @deprecated Use `payload.sab`.
   */
  sab?: SharedArrayBuffer;
  /**
   * @deprecated Use `payload.config`.
   */
  payloadConfig?: PayloadBufferOptions;
  headersBuffer: Uint32Array;
  headerSlotStrideU32?: number;
  textCompat?: LockBufferTextCompat;
  onPromise?: PromisePayloadHandler;
}) => {
  const payloadSab = payload?.sab ?? sab;
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payloadSab,
    options: payload?.config ?? payloadConfig,
  });
  const maxPayloadBytes = resolvedPayloadConfig.maxPayloadBytes;

  const { allocTask, setSlotLength, free } = register({
    lockSector,
  });
  const {
    writeBinary: writeDynamicBinary,
    writeBuffer: writeDynamicBuffer,
    writeArrayBuffer: writeDynamicArrayBuffer,
    write8Binary: writeDynamic8Binary,
    writeUtf8: writeDynamicUtf8,
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

  const reserveDynamic = (task: Task, bytes: number) => {
    task[TaskIndex.PayloadLen] = bytes;
    // PayloadCodec only reserves after the lock has guaranteed capacity.
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
    if (!ensureWithinDynamicLimit(task, bytes, PayloadBuffer[dynamicType])) {
      return false;
    }
    const reservedSlot = reserveDynamicObject(task, bytes);
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
    if (bytes <= staticMaxBytes) {
      writeStaticExactUint8Array(bytesView, slotIndex);
      task[TaskIndex.Type] = PayloadBuffer.StaticBinary;
      task[TaskIndex.PayloadLen] = bytes;
      task.value = null;
      return true;
    }

    task[TaskIndex.Type] = PayloadBuffer.Binary;
    if (!ensureWithinDynamicLimit(task, bytes, "Binary")) return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
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

    task[TaskIndex.Type] = PayloadBuffer.ArrayBuffer;
    if (!ensureWithinDynamicLimit(task, bytes, "ArrayBuffer")) return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    const written = writeDynamicArrayBuffer(arrayBuffer, task[TaskIndex.Start]);
    if (written < 0) return failDynamicWriteAfterReserve(task, reservedSlot);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(reservedSlot, written);
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
  const encodeObjectEnvelope = (
    task: Task,
    slotIndex: number,
    envelope: Envelope,
  ) => {
    const header = envelope.header;
    const payload = envelope.payload;
    const headerIsString = typeof header === "string";
    if (!(payload instanceof ArrayBuffer)) {
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: ENVELOPE_PAYLOAD_DETAIL,
      });
    }
    if (hasPromiseInEnvelopeHeader(header)) {
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: ENVELOPE_PROMISE_DETAIL,
      });
    }

    let headerText: string | undefined;
    if (headerIsString) {
      headerText = header;
    } else {
      try {
        headerText = stringifyJSON(header);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return encoderError({
          task,
          type: ErrorKnitting.Json,
          onPromise,
          detail,
        });
      }
    }
    if (typeof headerText !== "string") {
      return encoderError({
        task,
        type: ErrorKnitting.Serializable,
        onPromise,
        detail: ENVELOPE_HEADER_DETAIL,
      });
    }

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
      }
      task.value = null;
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
    return true;
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
          if (isRuntimeUint8Array(objectValue)) {
            return encodeObjectUint8Array(
              task,
              slotIndex,
              objectValue as Uint8Array,
            );
          }

          if (
            arrayIsArray(objectValue) ||
            objectProto === objectPrototype ||
            objectProto === null
          ) {
            let text: string;
            try {
              text = stringifyJSON(objectValue);
            } catch (error) {
              const detail = error instanceof Error
                ? error.message
                : String(error);
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
                task.value = null;
                return true;
              }
            }

            task[TaskIndex.Type] = PayloadBuffer.Json;
            const reserveBytes = dynamicUtf8ReserveBytes(task, text, "Json");
            if (reserveBytes < 0) return false;
            const reservedSlot = reserveDynamicObject(task, reserveBytes);
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
}: {
  lockSector?: SharedBufferSource;
  payload?: {
    sab?: SharedArrayBuffer;
    config?: PayloadBufferOptions;
  };
  /**
   * @deprecated Use `payload.sab`.
   */
  sab?: SharedArrayBuffer;
  /**
   * @deprecated Use `payload.config`.
   */
  payloadConfig?: PayloadBufferOptions;
  headersBuffer: Uint32Array;
  headerSlotStrideU32?: number;
  textCompat?: LockBufferTextCompat;
  host?: true;
}) => {
  const payloadSab = payload?.sab ?? sab;
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payloadSab,
    options: payload?.config ?? payloadConfig,
  });
  const { free } = register({
    lockSector,
  });
  const freeTaskSlot = (task: Task) => free(getTaskSlotIndex(task));
  const {
    readUtf8: readDynamicUtf8,
    readBytesCopy: readDynamicBytesCopy,
    readBytesBufferCopy: readDynamicBufferCopy,
    readBufferCopy: readDynamicBuffer,
    readBytesArrayBufferCopy: readDynamicArrayBufferCopy,
    readArrayBufferCopy: readDynamicArrayBuffer,
    read8BytesFloatCopy: readDynamic8BytesFloatCopy,
    read8BytesFloatView: readDynamic8BytesFloatView,
  } = createSharedDynamicBufferIO({
    sab: payloadSab,
    payloadConfig: resolvedPayloadConfig,
    textCompat: textCompat?.payload,
  });
  const {
    readUtf8: readStaticUtf8,
    readBytesCopy: readStaticBytesCopy,
    readBytesBufferCopy: readStaticBufferCopy,
    readBufferCopy: readStaticBuffer,
    readUint8ArrayCopy: readStaticUint8ArrayCopy,
    readBytesArrayBufferCopy: readStaticArrayBufferCopy,
    readArrayBufferCopy: readStaticArrayBuffer,
    read8BytesFloatCopy: readStatic8BytesFloatCopy,
  } = requireStaticIO(
    headersBuffer,
    headerSlotStrideU32,
    textCompat?.headers,
  );

  // TODO: remove slotIndex and make that all their callers
  // store the slot in their Task, to just get it when it comes
  // to the static versions of decoding
  return (task: Task, slotIndex: number, specialFlags?: number) => {
    switch (task[TaskIndex.Type]) {
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
        const payloadLength = task[TaskIndex.End];
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
        const payloadLength = task[TaskIndex.End];
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
