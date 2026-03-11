import {
  EncodeStatus,
  HEADER_BYTE_LENGTH,
  getTaskSlotIndex,
  PayloadBuffer,
  PromisePayloadFulfillSymbol,
  PromisePayloadHandlerSymbol,
  PromisePayloadStatus,
  PromisePayloadStatusSymbol,
  PayloadSignal,
  PromisePayloadMarker,
  PromisePayloadRejectSymbol,
  type PromisePayloadHandler,
  type Task,
  TaskIndex,
} from "./lock.ts";
import { register, type RegisterMalloc } from "./regionRegistry.ts"
import { createSharedDynamicBufferIO, createSharedStaticBufferIO } from "./createSharedBufferIO.ts"
import { Buffer as NodeBuffer } from "node:buffer";
import { ErrorKnitting, encoderError } from "../error.ts";
import { Envelope } from "../common/envelope.ts";
import {
  resolvePayloadBufferOptions,
  type PayloadBufferOptions,
} from "./payload-config.ts";

const memory = new ArrayBuffer(8);
const Float64View = new Float64Array(memory);
const BigInt64View = new BigInt64Array(memory);
const Uint32View = new Uint32Array(memory);
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
const ENVELOPE_PAYLOAD_DETAIL =
  "Envelope payload must be an ArrayBuffer.";
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

const initStaticIO = (headersBuffer: Uint32Array) => {
  if (headersBuffer.byteLength < HEADER_BYTE_LENGTH) return null;

  return createSharedStaticBufferIO({
    headersBuffer: headersBuffer.buffer as SharedArrayBuffer,
  });
};

const requireStaticIO = (headersBuffer: Uint32Array) => {
  const staticIO = initStaticIO(headersBuffer);
  if (staticIO === null) {
    throw new RangeError("headersBuffer is too small for static payload IO");
  }
  return staticIO;
};


/**
 * Returns `EncodeStatus.Sent` when the payload is encoded successfully.
 * Returns `EncodeStatus.Full` when the caller should retry later.
 * Returns `EncodeStatus.Deferred` when the payload will settle asynchronously.
 */

export const encodePayload = ({
  lockSector,
  payload,
  sab,
  payloadConfig,
  headersBuffer,
  onPromise,
  sharedRegister,
}: {
  lockSector?: SharedArrayBuffer;
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
  onPromise?: PromisePayloadHandler;
  sharedRegister?: RegisterMalloc;
}  ) =>  { 
  const payloadSab = payload?.sab ?? sab;
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payloadSab,
    options: payload?.config ?? payloadConfig,
  });
  const maxPayloadBytes = resolvedPayloadConfig.maxPayloadBytes;

  const { allocTask, setSlotLength, free } = sharedRegister ?? register({
    lockSector,
  });
  const {
    writeBinary: writeDynamicBinary,
    write8Binary: writeDynamic8Binary,
    writeUtf8: writeDynamicUtf8,
  } = createSharedDynamicBufferIO({
    sab: payloadSab,
    payloadConfig: resolvedPayloadConfig,
  });
  const {
    maxBytes: staticMaxBytes,
    writeBinary: writeStaticBinary,
    write8Binary: writeStatic8Binary,
    writeUtf8: writeStaticUtf8,
  } = requireStaticIO(headersBuffer);
  const dynamicLimitError = (
    task: Task,
    actualBytes: number,
    label: string,
  ) =>
    encoderError({
      task,
      type: ErrorKnitting.Serializable,
      onPromise,
      detail:
        `${DYNAMIC_PAYLOAD_LIMIT_DETAIL} limit=${maxPayloadBytes}; ` +
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

    const exactBytes = NodeBuffer.byteLength(text, "utf8");
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
    // allocTask returns slotIndex directly; use it to avoid redundant slotOf call
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
    if (!ensureWithinDynamicLimit(task, bytes, PayloadBuffer[dynamicType])) {
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
  const encodeObjectArrayBuffer = (
    task: Task,
    slotIndex: number,
    arrayBuffer: ArrayBuffer,
  ) => {
    const bytes = arrayBuffer.byteLength;
    let bytesView: Uint8Array | undefined;
    if (bytes <= staticMaxBytes) {
      bytesView = new Uint8Array(arrayBuffer);
      const written = writeStaticBinary(bytesView, slotIndex);
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
    if (reservedSlot === -1) return false;
    const written = writeDynamicBinary(
      bytesView ?? new Uint8Array(arrayBuffer),
      task[TaskIndex.Start],
    );
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
    const headerIsString = typeof header === "string";
    const payload = envelope.payload;
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
      }
      task.value = null;
      return true;
    }

    const headerReserveBytes = dynamicUtf8ReserveBytesWithExtra(
      task,
      headerText,
      payloadLength,
      headerIsString
        ? "EnvelopeDynamicHeaderString"
        : "EnvelopeDynamicHeader",
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
    return true;
  };
  const encodeObjectPromise = (task: Task, promise: Promise<unknown>) => {
    const markedTask = task as Task & {
      [PromisePayloadMarker]?: boolean;
      [PromisePayloadHandlerSymbol]?: PromisePayloadHandler;
      [PromisePayloadStatusSymbol]?: PromisePayloadStatus;
      [PromisePayloadFulfillSymbol]?: (value: unknown) => void;
      [PromisePayloadRejectSymbol]?: (reason: unknown) => void;
    };
    markedTask[PromisePayloadHandlerSymbol] = onPromise;
    if (markedTask[PromisePayloadMarker] !== true) {
      markedTask[PromisePayloadMarker] = true;
      markedTask[PromisePayloadStatusSymbol] = PromisePayloadStatus.Idle;
      promise.then(
        markedTask[PromisePayloadFulfillSymbol],
        markedTask[PromisePayloadRejectSymbol],
      );
    }
    return EncodeStatus.Deferred;
  };
  const encodeFailureStatus = (task: Task): EncodeStatus =>
    (task as Task & {
      [PromisePayloadMarker]?: boolean;
    })[PromisePayloadMarker] === true
      ? EncodeStatus.Deferred
      : EncodeStatus.Full;

  // Named function so V8/TurboFan can compile it independently from the
  // encodePayload factory closure. Anonymous returns prevent full optimization
  // because the outer factory is too large for TurboFan's bytecode limit.
  const encodeDispatch = (task: Task, slotIndex: number): EncodeStatus => {
    const args = task.value;
    switch (typeof args) {
      case "bigint":
        if (args < BIGINT64_MIN || args > BIGINT64_MAX) {
          const binaryBytes = encodeBigIntIntoScratch(args);
          const binary = bigintScratch.subarray(0, binaryBytes);
          if (binaryBytes <= staticMaxBytes) {
            const written = writeStaticBinary(binary, slotIndex);
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticBigInt;
              task[TaskIndex.PayloadLen] = written;
              clearBigIntScratch(binaryBytes);
              task.value = null;
              return EncodeStatus.Sent;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.BigInt;
          if (!ensureWithinDynamicLimit(task, binaryBytes, "BigInt")) {
            clearBigIntScratch(binaryBytes);
            return encodeFailureStatus(task);
          }
          const reservedSlot = reserveDynamic(task, binaryBytes);
          if (reservedSlot < 0) {
            clearBigIntScratch(binaryBytes);
            return EncodeStatus.Full;
          }
          const written = writeDynamicBinary(binary, task[TaskIndex.Start]);
          if (written < 0) {
            clearBigIntScratch(binaryBytes);
            failDynamicWriteAfterReserve(task, reservedSlot);
            return encodeFailureStatus(task);
          }
          task[TaskIndex.PayloadLen] = written;
          setSlotLength(reservedSlot, written);
          clearBigIntScratch(binaryBytes);
          task.value = null;
          return EncodeStatus.Sent;
        }
        BigInt64View[0] = args;
        task[TaskIndex.Type] = PayloadSignal.BigInt;
        task[TaskIndex.Start] = Uint32View[0];
        task[TaskIndex.End] = Uint32View[1];
        task.value = null;
        return EncodeStatus.Sent;
      case "boolean":
        task[TaskIndex.Type] =
          task.value === true ? PayloadSignal.True : PayloadSignal.False;
        return EncodeStatus.Sent;
      case "function":
        encoderError({
          task,
          type: ErrorKnitting.Function,
          onPromise,
        });
        return encodeFailureStatus(task);
      case "number":
        if (args !== args) {
          task[TaskIndex.Type] = PayloadSignal.NaN;
          return EncodeStatus.Sent;
        }

        Float64View[0] = args;
        task[TaskIndex.Type] = PayloadSignal.Float64;
        task[TaskIndex.Start] = Uint32View[0];
        task[TaskIndex.End] = Uint32View[1];
        return EncodeStatus.Sent;
      case "object":
        if (args === null) {
          task[TaskIndex.Type] = PayloadSignal.Null;
          return EncodeStatus.Sent;
        }
        objectDynamicSlot = -1;

        try {
          const objectValue = args as object;
          if (arrayIsArray(objectValue) || isPlainJsonObject(objectValue)) {
            let text: string;
            try {
              text = stringifyJSON(objectValue);
            } catch (error) {
              const detail = error instanceof Error
                ? error.message
                : String(error);
              encoderError({
                task,
                type: ErrorKnitting.Json,
                onPromise,
                detail,
              });
              return encodeFailureStatus(task);
            }
            if (text.length <= staticMaxBytes) {
              const written = writeStaticUtf8(text, slotIndex);
              if (written !== -1) {
                task[TaskIndex.Type] = PayloadBuffer.StaticJson;
                task[TaskIndex.PayloadLen] = written;
                task.value = null;
                return EncodeStatus.Sent;
              }
            }

            task[TaskIndex.Type] = PayloadBuffer.Json;
            const reserveBytes = dynamicUtf8ReserveBytes(task, text, "Json");
            if (reserveBytes < 0) return encodeFailureStatus(task);
            const reservedSlot = reserveDynamicObject(task, reserveBytes);
            if (reservedSlot === -1) return EncodeStatus.Full;
            const written = writeDynamicUtf8(
              text,
              task[TaskIndex.Start],
              reserveBytes,
            );
            if (written < 0) {
              failDynamicWriteAfterReserve(task, reservedSlot);
              return encodeFailureStatus(task);
            }
            task[TaskIndex.PayloadLen] = written;
            setSlotLength(reservedSlot, written);
            task.value = null;
            return EncodeStatus.Sent;
          }

          if (NodeBuffer.isBuffer(objectValue)) {
            return encodeObjectBinary(
              task,
              slotIndex,
              objectValue as NodeBuffer,
              PayloadBuffer.Buffer,
              PayloadBuffer.StaticBuffer,
            )
              ? EncodeStatus.Sent
              : encodeFailureStatus(task);
          }

          switch ((objectValue as { constructor?: unknown }).constructor) {
            case Uint8Array:
              return encodeObjectBinary(
                task,
                slotIndex,
                objectValue as Uint8Array,
                PayloadBuffer.Binary,
                PayloadBuffer.StaticBinary,
              )
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
            case ArrayBuffer:
              return encodeObjectArrayBuffer(
                task,
                slotIndex,
                objectValue as ArrayBuffer,
              )
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
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
              )
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
            }
            case Float64Array:
              return encodeObjectFloat64Array(
                task,
                slotIndex,
                objectValue as Float64Array,
              )
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
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
              )
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
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
              )
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
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
              )
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
            }
            case Date:
              return encodeObjectDate(task, objectValue as Date)
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
            case Envelope:
              return encodeObjectEnvelope(
                task,
                slotIndex,
                objectValue as Envelope,
              )
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
            case Promise:
              return encodeObjectPromise(task, objectValue as Promise<unknown>);
            case Error:
              return encodeErrorObject(task, objectValue as Error)
                ? EncodeStatus.Sent
                : encodeFailureStatus(task);
          }

          if (objectValue instanceof Date) {
            return encodeObjectDate(task, objectValue)
              ? EncodeStatus.Sent
              : encodeFailureStatus(task);
          }
          if (objectValue instanceof Envelope) {
            return encodeObjectEnvelope(task, slotIndex, objectValue)
              ? EncodeStatus.Sent
              : encodeFailureStatus(task);
          }
          if (objectValue instanceof Promise) {
            return encodeObjectPromise(task, objectValue);
          }
          if (objectValue instanceof Error) {
            return encodeErrorObject(task, objectValue)
              ? EncodeStatus.Sent
              : encodeFailureStatus(task);
          }

          encoderError({
            task,
            type: ErrorKnitting.Serializable,
            onPromise,
            detail: UNSUPPORTED_OBJECT_DETAIL,
          });
          return encodeFailureStatus(task);
        } catch (error) {
          rollbackObjectDynamic();
          const detail = error instanceof Error ? error.message : String(error);
          encoderError({
            task,
            type: ErrorKnitting.Serializable,
            onPromise,
            detail,
          });
          return encodeFailureStatus(task);
        }
      case "string": {
        const text = args as string;
        if (text.length <= staticMaxBytes) {
          const written = writeStaticUtf8(text, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticString;
            task[TaskIndex.PayloadLen] = written;
            task.value = null;
            return EncodeStatus.Sent;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.String;
        const reserveBytes = dynamicUtf8ReserveBytes(task, text, "String");
        if (reserveBytes < 0) return encodeFailureStatus(task);
        const reservedSlot = reserveDynamic(task, reserveBytes);
        if (reservedSlot < 0) return EncodeStatus.Full;

        const written = writeDynamicUtf8(
          text,
          task[TaskIndex.Start],
          reserveBytes,
        );
        if (written < 0) {
          failDynamicWriteAfterReserve(task, reservedSlot);
          return encodeFailureStatus(task);
        }
        task[TaskIndex.PayloadLen] = written;
        setSlotLength(reservedSlot, written);
        task.value = null;
        return EncodeStatus.Sent;
      }
      case "symbol": {
        const key = symbolKeyFor(args);
        if (key === undefined) {
          encoderError({
            task,
            type: ErrorKnitting.Symbol,
            onPromise,
          });
          return encodeFailureStatus(task);
        }
        if (key.length * 3 <= staticMaxBytes) {
          const written = writeStaticUtf8(key, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticSymbol;
            task[TaskIndex.PayloadLen] = written;
            task.value = null;
            return EncodeStatus.Sent;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.Symbol;
        const reserveBytes = dynamicUtf8ReserveBytes(task, key, "Symbol");
        if (reserveBytes < 0) return encodeFailureStatus(task);
        const reservedSlot = reserveDynamic(task, reserveBytes);
        if (reservedSlot < 0) return EncodeStatus.Full;
        const written = writeDynamicUtf8(
          key,
          task[TaskIndex.Start],
          reserveBytes,
        );
        if (written < 0) {
          failDynamicWriteAfterReserve(task, reservedSlot);
          return encodeFailureStatus(task);
        }
        task[TaskIndex.PayloadLen] = written;
        setSlotLength(reservedSlot, written);
        task.value = null;
        return EncodeStatus.Sent;
      }
      case "undefined":
        task[TaskIndex.Type] = PayloadSignal.Undefined;
        return EncodeStatus.Sent;
    }
    return EncodeStatus.Full;
  };

  return encodeDispatch;
}

export const decodePayload = ({
  lockSector,
  payload,
  sab,
  payloadConfig,
  headersBuffer,
  host,
  sharedRegister,
}: {
  lockSector?: SharedArrayBuffer;
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
  headersBuffer: Uint32Array
  host?: true
  sharedRegister?: RegisterMalloc;
}  ) => {
  const payloadSab = payload?.sab ?? sab;
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payloadSab,
    options: payload?.config ?? payloadConfig,
  });
  const { free } = sharedRegister ?? register({
    lockSector,
  });
  const freeTaskSlot = (task: Task) => free(getTaskSlotIndex(task));
  const {
    readUtf8: readDynamicUtf8,
    readBytesCopy: readDynamicBytesCopy,
    readBytesBufferCopy: readDynamicBufferCopy,
    readBytesArrayBufferCopy: readDynamicArrayBufferCopy,
    read8BytesFloatCopy: readDynamic8BytesFloatCopy,
    read8BytesFloatView: readDynamic8BytesFloatView,
  } = createSharedDynamicBufferIO({
    sab: payloadSab,
    payloadConfig: resolvedPayloadConfig,
  });
  const {
    readUtf8: readStaticUtf8,
    readBytesCopy: readStaticBytesCopy,
    readBytesBufferCopy: readStaticBufferCopy,
    readBytesArrayBufferCopy: readStaticArrayBufferCopy,
    read8BytesFloatCopy: readStatic8BytesFloatCopy,
  } = requireStaticIO(headersBuffer);
  
  // TODO: remove slotIndex and make that all their callers
  // store the slot in their Task, to just get it when it comes 
  // to the static versions of decoding
  return (task: Task, slotIndex: number , specialFlags?: number)=>  {



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
      return
    case PayloadSignal.NaN:
      task.value = NaN
      return
    case PayloadSignal.Null :
      task.value = null
      return
    case PayloadSignal.Undefined:
      task.value = undefined
      return
    case PayloadBuffer.String:
      task.value = readDynamicUtf8(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      freeTaskSlot(task)
    return
    case PayloadBuffer.StaticString:
  
      task.value = readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex)
    return
    case PayloadBuffer.Json:
      task.value = parseJSON(
        readDynamicUtf8(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      freeTaskSlot(task)
    return
    case PayloadBuffer.StaticJson:

      task.value = parseJSON(
        readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex)
      )
    return
    case PayloadBuffer.EnvelopeStaticHeader:
    case PayloadBuffer.EnvelopeStaticHeaderString: {
      const rawHeader = readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex);
      const header = task[TaskIndex.Type] === PayloadBuffer.EnvelopeStaticHeaderString
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
    return
    }
    case PayloadBuffer.EnvelopeDynamicHeader:
    case PayloadBuffer.EnvelopeDynamicHeaderString: {
      const headerStart = task[TaskIndex.Start];
      const payloadStart = headerStart + task[TaskIndex.PayloadLen];
      const payloadLength = task[TaskIndex.End];
      const rawHeader = readDynamicUtf8(headerStart, payloadStart);
      const header = task[TaskIndex.Type] === PayloadBuffer.EnvelopeDynamicHeaderString
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
    return
    }
    case PayloadBuffer.BigInt:
      task.value = decodeBigIntBinary(
        readDynamicBufferCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      freeTaskSlot(task)
    return
    case PayloadBuffer.StaticBigInt:
      task.value = decodeBigIntBinary(
        readStaticBufferCopy(0, task[TaskIndex.PayloadLen], slotIndex)
      )
    return
    case PayloadBuffer.Symbol:
      task.value = symbolFor(
        readDynamicUtf8(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      freeTaskSlot(task)
    return
    case PayloadBuffer.StaticSymbol:
      task.value = symbolFor(
        readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex)
      )
    return
    case PayloadBuffer.Int32Array: {
      const bytes = readDynamicBufferCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      task.value = new Int32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 2
      )
      freeTaskSlot(task)
    return
    }
    case PayloadBuffer.StaticInt32Array: {
      const bytes = readStaticBufferCopy(0, task[TaskIndex.PayloadLen], slotIndex)
      task.value = new Int32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 2
      )
    return
    }
    case PayloadBuffer.Float64Array: {
      task.value = readDynamic8BytesFloatCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      freeTaskSlot(task)
    return
    }
    case PayloadBuffer.StaticFloat64Array:
      task.value = readStatic8BytesFloatCopy(0, task[TaskIndex.PayloadLen], slotIndex)
    return
    case PayloadBuffer.BigInt64Array: {
      const bytes = readDynamicBufferCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      task.value = new BigInt64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 3
      )
      freeTaskSlot(task)
    return
    }
    case PayloadBuffer.StaticBigInt64Array: {
      const bytes = readStaticBufferCopy(0, task[TaskIndex.PayloadLen], slotIndex)
      task.value = new BigInt64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 3
      )
    return
    }
    case PayloadBuffer.BigUint64Array: {
      const bytes = readDynamicBufferCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      task.value = new BigUint64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 3
      )
      freeTaskSlot(task)
    return
    }
    case PayloadBuffer.StaticBigUint64Array: {
      const bytes = readStaticBufferCopy(0, task[TaskIndex.PayloadLen], slotIndex)
      task.value = new BigUint64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 3
      )
    return
    }
    case PayloadBuffer.DataView: {
      const bytes = readDynamicBufferCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      task.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      freeTaskSlot(task)
    return
    }
    case PayloadBuffer.StaticDataView: {
      const bytes = readStaticBufferCopy(0, task[TaskIndex.PayloadLen], slotIndex)
      task.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return
    }
    case PayloadBuffer.Date:
      Uint32View[0] = task[TaskIndex.Start]
      Uint32View[1] = task[TaskIndex.End]
      task.value = new Date(Float64View[0])
    return
    case PayloadBuffer.Error:
      task.value = parseErrorPayload(
        readDynamicUtf8(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        ),
      );
      freeTaskSlot(task);
    return
    case PayloadBuffer.Binary:
      {
        const buffer = readDynamicBufferCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
        )
        task.value = new Uint8Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength,
        )
      }
      freeTaskSlot(task)
    return
    case PayloadBuffer.StaticBinary:
      task.value = readStaticBufferCopy(0, task[TaskIndex.PayloadLen], slotIndex)
    return
    case PayloadBuffer.ArrayBuffer:
      task.value = readDynamicArrayBufferCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen],
      )
      freeTaskSlot(task)
    return
    case PayloadBuffer.StaticArrayBuffer:
      task.value = readStaticArrayBufferCopy(
        0,
        task[TaskIndex.PayloadLen],
        slotIndex,
      )
    return
    case PayloadBuffer.Buffer:
      task.value = readDynamicBufferCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      freeTaskSlot(task)
    return
    case PayloadBuffer.StaticBuffer:
      task.value = readStaticBufferCopy(0, task[TaskIndex.PayloadLen], slotIndex)
    return
  }
} 
}
