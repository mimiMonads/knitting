import {
  getTaskSlotIndex,
  LockBound,
  PayloadBuffer,
  PayloadSignal,
  PromisePayloadMarker,
  type PromisePayloadHandler,
  type Task,
  TaskIndex,
} from "./lock.ts";
import { register } from "./regionRegistry.ts"
import { createSharedDynamicBufferIO, createSharedStaticBufferIO } from "./createSharedBufferIO.ts"
import { Buffer as NodeBuffer } from "node:buffer";
import { ErrorKnitting, encoderError } from "../error.ts";
import { Envelope } from "../common/envelope.ts";

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
const arrayBufferIsView = ArrayBuffer.isView;
const objectPrototype = Object.prototype;
const int32ArrayPrototype = Int32Array.prototype;
const float64ArrayPrototype = Float64Array.prototype;
const bigInt64ArrayPrototype = BigInt64Array.prototype;
const bigUint64ArrayPrototype = BigUint64Array.prototype;
const dataViewPrototype = DataView.prototype;
const UNSUPPORTED_OBJECT_DETAIL =
  "Unsupported object type. Allowed: plain object, array, Error, Date, Envelope, Buffer, ArrayBuffer, DataView, and typed arrays. Serialize it yourself.";
const ENVELOPE_PAYLOAD_DETAIL =
  "Envelope payload must be an ArrayBuffer.";
const ENVELOPE_HEADER_DETAIL =
  "Envelope header must be a JSON-like value or string.";
const ENVELOPE_PROMISE_DETAIL =
  "Envelope header cannot contain Promise values.";

const VIEW_KIND_UNKNOWN = 0;
const VIEW_KIND_INT32_ARRAY = 1;
const VIEW_KIND_FLOAT64_ARRAY = 2;
const VIEW_KIND_BIGINT64_ARRAY = 3;
const VIEW_KIND_BIGUINT64_ARRAY = 4;
const VIEW_KIND_DATA_VIEW = 5;
type ArrayBufferViewKindType = 0 | 1 | 2 | 3 | 4 | 5;

const getArrayBufferViewKind = (value: object): ArrayBufferViewKindType => {
  const proto = objectGetPrototypeOf(value);
  if (proto === int32ArrayPrototype) return VIEW_KIND_INT32_ARRAY;
  if (proto === float64ArrayPrototype) return VIEW_KIND_FLOAT64_ARRAY;
  if (proto === bigInt64ArrayPrototype) return VIEW_KIND_BIGINT64_ARRAY;
  if (proto === bigUint64ArrayPrototype) {
    return VIEW_KIND_BIGUINT64_ARRAY;
  }
  if (proto === dataViewPrototype) return VIEW_KIND_DATA_VIEW;
  if (value instanceof Int32Array) return VIEW_KIND_INT32_ARRAY;
  if (value instanceof Float64Array) return VIEW_KIND_FLOAT64_ARRAY;
  if (value instanceof BigInt64Array) return VIEW_KIND_BIGINT64_ARRAY;
  if (value instanceof BigUint64Array) {
    return VIEW_KIND_BIGUINT64_ARRAY;
  }
  if (value instanceof DataView) return VIEW_KIND_DATA_VIEW;
  return VIEW_KIND_UNKNOWN;
};

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
  const u32Bytes = Uint32Array.BYTES_PER_ELEMENT;
  const slotStride = LockBound.header + TaskIndex.TotalBuff;
  const slotOffset = (at: number) => (at * slotStride) + LockBound.header;
  const slotStartBytes = (at: number) =>
    (slotOffset(at) + TaskIndex.Size) * u32Bytes;
  const writableBytes = (TaskIndex.TotalBuff - TaskIndex.Size) * u32Bytes;
  const requiredBytes = slotStartBytes(LockBound.slots - 1) + writableBytes;

  if (headersBuffer.byteLength < requiredBytes) return null;

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
 * Returns `true` when the payload is encoded successfully.
 * Returns `false` when dynamic payload space could not be reserved.
 */

export const encodePayload = ({
  lockSector,
  sab,
  headersBuffer,
  onPromise,
}: {
  lockSector?: SharedArrayBuffer;
  sab?: SharedArrayBuffer;
  headersBuffer: Uint32Array;
  onPromise?: PromisePayloadHandler;
}  ) =>  { 
  
  const { allocTask, setSlotLength, free } = register({
    lockSector,
  });
  const {
    writeBinary: writeDynamicBinary,
    write8Binary: writeDynamic8Binary,
    writeUtf8: writeDynamicUtf8,
  } = createSharedDynamicBufferIO({
    sab,
  });
  const {
    maxBytes: staticMaxBytes,
    writeBinary: writeStaticBinary,
    write8Binary: writeStatic8Binary,
    writeUtf8: writeStaticUtf8,
  } = requireStaticIO(headersBuffer);
  const slotOf = (task: Task) => getTaskSlotIndex(task);

  const reserveDynamic = (task: Task, bytes: number) => {
    task[TaskIndex.PayloadLen] = bytes;
    if (allocTask(task) === -1) return false;
    return true;
  };
  let objectDynamicSlot = -1;
  const reserveDynamicObject = (task: Task, bytes: number) => {
    task[TaskIndex.PayloadLen] = bytes;
    if (allocTask(task) === -1) return false;
    objectDynamicSlot = slotOf(task);
    return true;
  };
  const rollbackObjectDynamic = () => {
    if (objectDynamicSlot !== -1) {
      free(objectDynamicSlot);
      objectDynamicSlot = -1;
    }
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
    const estimatedBytes = text.length * 3;
    task[TaskIndex.Type] = PayloadBuffer.Error;
    if (!reserveDynamicObject(task, estimatedBytes)) return false;
    const written = writeDynamicUtf8(text, task[TaskIndex.Start]);
    task[TaskIndex.PayloadLen] = written;
    setSlotLength(slotOf(task), written);
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
    if (!reserveDynamicObject(task, bytes)) return false;
    writeDynamicBinary(bytesView, task[TaskIndex.Start]);
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
    if (!reserveDynamicObject(task, bytes)) return false;
    writeDynamic8Binary(float64, task[TaskIndex.Start]);
    task.value = null;
    return true;
  };

  const toUint8View = (value: ArrayBufferView) =>
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  return (task: Task, slotIndex: number) => {
  const args = task.value
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
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.BigInt;
        if (!reserveDynamic(task, binaryBytes)) {
          clearBigIntScratch(binaryBytes);
          return false;
        }
        writeDynamicBinary(binary, task[TaskIndex.Start])
        clearBigIntScratch(binaryBytes);
        return true
      }
      BigInt64View[0] = args;
      task[TaskIndex.Type] = PayloadSignal.BigInt;
      task[TaskIndex.Start] = Uint32View[0];
      task[TaskIndex.End] = Uint32View[1];
      return true;
    case "boolean":
      task[TaskIndex.Type] =
        task.value === true ? PayloadSignal.True : PayloadSignal.False;
      return true;
    case "function":
      return encoderError({
        task,
        type: ErrorKnitting.Function,
        onPromise,
      });
    case "number":

      if (args !== args) {
        task[TaskIndex.Type] = PayloadSignal.NaN;
        return true;
      }
      switch (args) {
      case Infinity:
        task[TaskIndex.Type]  = PayloadSignal.Infinity;
        return true;
      case -Infinity:
        task[TaskIndex.Type]  = PayloadSignal.NegativeInfinity;
        return true;
      }

      Float64View[0] = args;
      task[TaskIndex.Type] = PayloadSignal.Float64;
      task[TaskIndex.Start] = Uint32View[0];
      task[TaskIndex.End] = Uint32View[1];
      return true
    case "object" : 
      if (args === null) {
        task[TaskIndex.Type] = PayloadSignal.Null
        return true
      }
      objectDynamicSlot = -1;

      try {
      const objectValue = args as object;
      if (arrayIsArray(objectValue) || isPlainJsonObject(objectValue)) {
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
            task.value = null;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.Json;
        if (!reserveDynamicObject(task, text.length * 3)) return false;
        const written = writeDynamicUtf8(text, task[TaskIndex.Start]);
        task[TaskIndex.PayloadLen] = written;
        setSlotLength(slotOf(task), written);
        task.value = null;
        return true;
      }

      if (NodeBuffer.isBuffer(objectValue)) {
        return encodeObjectBinary(
          task,
          slotIndex,
          objectValue as NodeBuffer,
          PayloadBuffer.Buffer,
          PayloadBuffer.StaticBuffer,
        );
      }

      if (objectValue instanceof Uint8Array) {
        return encodeObjectBinary(
          task,
          slotIndex,
          objectValue,
          PayloadBuffer.Binary,
          PayloadBuffer.StaticBinary,
        );
      }

      if (objectValue instanceof ArrayBuffer) {
        return encodeObjectBinary(
          task,
          slotIndex,
          new Uint8Array(objectValue),
          PayloadBuffer.ArrayBuffer,
          PayloadBuffer.StaticArrayBuffer,
        );
      }

      if (arrayBufferIsView(objectValue)) {
        switch (getArrayBufferViewKind(objectValue)) {
          case VIEW_KIND_INT32_ARRAY:
            return encodeObjectBinary(
              task,
              slotIndex,
              toUint8View(objectValue as Int32Array),
              PayloadBuffer.Int32Array,
              PayloadBuffer.StaticInt32Array,
            );
          case VIEW_KIND_FLOAT64_ARRAY:
            return encodeObjectFloat64Array(
              task,
              slotIndex,
              objectValue as Float64Array,
            );
          case VIEW_KIND_BIGINT64_ARRAY:
            return encodeObjectBinary(
              task,
              slotIndex,
              toUint8View(objectValue as BigInt64Array),
              PayloadBuffer.BigInt64Array,
              PayloadBuffer.StaticBigInt64Array,
            );
          case VIEW_KIND_BIGUINT64_ARRAY:
            return encodeObjectBinary(
              task,
              slotIndex,
              toUint8View(objectValue as BigUint64Array),
              PayloadBuffer.BigUint64Array,
              PayloadBuffer.StaticBigUint64Array,
            );
          case VIEW_KIND_DATA_VIEW:
            return encodeObjectBinary(
              task,
              slotIndex,
              toUint8View(objectValue as DataView),
              PayloadBuffer.DataView,
              PayloadBuffer.StaticDataView,
            );
        }
      }

      if (objectValue instanceof Date) {
        Float64View[0] = objectValue.getTime();
        task[TaskIndex.Type] = PayloadBuffer.Date;
        task[TaskIndex.Start] = Uint32View[0];
        task[TaskIndex.End] = Uint32View[1];
        task.value = null;
        return true;
      }

      if (objectValue instanceof Envelope) {
        const header = objectValue.header;
        const payload = objectValue.payload;
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
          if (!reserveDynamicObject(task, payloadReserveBytes)) return false;
          task[TaskIndex.Type] = PayloadBuffer.EnvelopeStaticHeader;
          task[TaskIndex.PayloadLen] = staticHeaderWritten;
          task[TaskIndex.End] = payloadLength;
          if (payloadLength > 0) {
            writeDynamicBinary(payloadBytes, task[TaskIndex.Start]);
          }
          task.value = null;
          return true;
        }

        const estimatedHeaderBytes = headerText.length * 3;
        const estimatedTotalBytes = estimatedHeaderBytes + payloadLength;
        task[TaskIndex.Type] = PayloadBuffer.EnvelopeDynamicHeader;
        if (!reserveDynamicObject(task, estimatedTotalBytes)) return false;
        const baseStart = task[TaskIndex.Start];
        const writtenHeaderBytes = writeDynamicUtf8(
          headerText,
          baseStart,
          estimatedHeaderBytes,
        );
        if (payloadLength > 0) {
          writeDynamicBinary(payloadBytes, baseStart + writtenHeaderBytes);
        }
        task[TaskIndex.PayloadLen] = writtenHeaderBytes;
        task[TaskIndex.End] = payloadLength;
        setSlotLength(
          slotOf(task),
          writtenHeaderBytes + payloadLength,
        );
        task.value = null;
        return true;
      }

      if (objectValue instanceof Promise) {
        const markedTask = task as Task & {
          [PromisePayloadMarker]?: boolean;
        };
        if (markedTask[PromisePayloadMarker] !== true) {
          markedTask[PromisePayloadMarker] = true;
          objectValue.then(
            (value) => {
              markedTask[PromisePayloadMarker] = false;
              task.value = value;
              onPromise?.(task, { status: "fulfilled", value });
            },
            (reason) => {
              markedTask[PromisePayloadMarker] = false;
              task.value = reason;
              onPromise?.(task, { status: "rejected", reason });
            },
          );
        }
        return false;
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
    case "string":
      {
        const text = args as string;
        const estimatedBytes = text.length * 3;
        if (text.length <= staticMaxBytes) {
          const written = writeStaticUtf8(text, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticString;
            task[TaskIndex.PayloadLen] = written;
            return true;
            
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.String;
        if (!reserveDynamic(task, estimatedBytes)) return false;

        const written = writeDynamicUtf8(
          text,
          task[TaskIndex.Start],
          estimatedBytes,
        );
        task[TaskIndex.PayloadLen] = written;
        setSlotLength(slotOf(task), written);
        return true
      }
    case "symbol":
      {
        const key = symbolKeyFor(args);
        if (key === undefined) {
          return encoderError({
            task,
            type: ErrorKnitting.Symbol,
            onPromise,
          });
        }
        const estimatedBytes = key.length * 3;
        if (estimatedBytes <= staticMaxBytes) {
          const written = writeStaticUtf8(key, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticSymbol;
            task[TaskIndex.PayloadLen] = written;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.Symbol;
        if (!reserveDynamic(task, estimatedBytes)) return false;
        const written = writeDynamicUtf8(key, task[TaskIndex.Start]);
        task[TaskIndex.PayloadLen] = written;
        setSlotLength(slotOf(task), written);
        return true;
      }
    case "undefined":
      task[TaskIndex.Type]  = PayloadSignal.Undefined
      return true
  }
}
}

export const decodePayload = ({
  lockSector,
  sab,
  headersBuffer,
  host,
}: {
  lockSector?: SharedArrayBuffer;
   sab?: SharedArrayBuffer; 
   headersBuffer: Uint32Array
   host?: true
}  ) => {
  
  const { free } = register({
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
    sab,
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
    case PayloadSignal.Infinity:
      task.value = Infinity
      return
    case PayloadSignal.NaN:
      task.value = NaN
      return
    case PayloadSignal.NegativeInfinity:
      task.value = -Infinity
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
    case PayloadBuffer.EnvelopeStaticHeader: {
      const header = parseJSON(
        readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex),
      );
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
    case PayloadBuffer.EnvelopeDynamicHeader: {
      const headerStart = task[TaskIndex.Start];
      const payloadStart = headerStart + task[TaskIndex.PayloadLen];
      const payloadLength = task[TaskIndex.End];
      const header = parseJSON(
        readDynamicUtf8(headerStart, payloadStart),
      );
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
        readDynamicBytesCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      freeTaskSlot(task)
    return
    case PayloadBuffer.StaticBigInt:
      task.value = decodeBigIntBinary(
        readStaticBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
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
      const bytes = readDynamicBytesCopy(
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
      const bytes = readStaticBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
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
      const bytes = readDynamicBytesCopy(
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
      const bytes = readStaticBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
      task.value = new BigInt64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 3
      )
    return
    }
    case PayloadBuffer.BigUint64Array: {
      const bytes = readDynamicBytesCopy(
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
      const bytes = readStaticBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
      task.value = new BigUint64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 3
      )
    return
    }
    case PayloadBuffer.DataView: {
      const bytes = readDynamicBytesCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      task.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      freeTaskSlot(task)
    return
    }
    case PayloadBuffer.StaticDataView: {
      const bytes = readStaticBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
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
      task.value = readStaticBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
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
