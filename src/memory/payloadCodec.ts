import {
  LockBound,
  PayloadBuffer,
  PayloadSingal,
  PromisePayloadMarker,
  type PromisePayloadHandler,
  type Task,
  TaskIndex,
} from "./lock.ts";
import { register } from "./regionRegistry.ts"
import { createSharedDynamicBufferIO, createSharedStaticBufferIO } from "./createSharedBufferIO.ts"
import { deserialize, serialize } from "node:v8";
import { Buffer } from "node:buffer";
import { NumericBuffer } from "../ipc/protocol/parsers/NumericBuffer.ts";

const memory = new ArrayBuffer(8);
const Float64View = new Float64Array(memory);
const BigInt64View = new BigInt64Array(memory);
const Uint32View = new Uint32Array(memory);
const BIGINT64_MIN = -(1n << 63n);
const BIGINT64_MAX = (1n << 63n) - 1n;
const { byteLength: utf8ByteLength } = Buffer;
const { parse: parseJSON, stringify: stringifyJSON } = JSON;
const { for: symbolFor, keyFor: symbolKeyFor } = Symbol;

const isThenable = (
  value: object | ((...args: unknown[]) => unknown),
): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown })?.then === "function";


const encodeBigIntBinary = (value: bigint) => {
  let sign = 0;
  let abs = value;
  if (value < 0n) {
    sign = 1;
    abs = -value;
  }

  const bytes: number[] = [];
  while (abs > 0n) {
    bytes.push(Number(abs & 0xffn));
    abs >>= 8n;
  }

  const out = new Uint8Array(1 + bytes.length);
  out[0] = sign;
  for (let i = 0; i < bytes.length; i++) out[i + 1] = bytes[i];
  return out;
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
  
  const { allocTask } = register({
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

  const reserveDynamic = (task: Task, bytes: number) => {
    task[TaskIndex.PayloadLen] = bytes;
    if (allocTask(task) === -1) return false;
    return true;
  };

  return (task: Task, slotIndex: number) => {
  const args = task.value
  switch (typeof args) {
    case "bigint":
      if (args < BIGINT64_MIN || args > BIGINT64_MAX) {
        const binary = encodeBigIntBinary(args);
        if (binary.byteLength <= staticMaxBytes) {
          const written = writeStaticBinary(binary, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticBigInt;
            task[TaskIndex.PayloadLen] = written;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.BigInt;
        if (!reserveDynamic(task, binary.byteLength)) return false;
        writeDynamicBinary(binary, task[TaskIndex.Start])
        return true
      }
      BigInt64View[0] = args;
      task[TaskIndex.Type] = PayloadSingal.BigInt;
      task[TaskIndex.Start] = Uint32View[0];
      task[TaskIndex.End] = Uint32View[1];
      return true;
    case "boolean":
      task[TaskIndex.Type] =
        task.value === true ? PayloadSingal.True : PayloadSingal.False;
      return true;
    case "function":
      if (isThenable(args)) {
        const markedTask = task as Task & { [PromisePayloadMarker]?: true };
        if (markedTask[PromisePayloadMarker] !== true) {
          markedTask[PromisePayloadMarker] = true;
          args.then(
            (value) => {
              delete markedTask[PromisePayloadMarker];
              task.value = value;
              onPromise?.(task, { status: "fulfilled", value });
            },
            (reason) => {
              delete markedTask[PromisePayloadMarker];
              task.value = reason;
              onPromise?.(task, { status: "rejected", reason });
            },
          );
        }
        return false;
      }
      throw "you cant pass a function ";
    case "number":

      if (args !== args) {
        task[TaskIndex.Type] = PayloadSingal.NaN;
        return true;
      }
      switch (args) {
      case Infinity:
        task[TaskIndex.Type]  = PayloadSingal.Infinity;
        return true;
      case -Infinity:
        task[TaskIndex.Type]  = PayloadSingal.NegativeInfinity;
        return true;
      }

      Float64View[0] = args;
      task[TaskIndex.Type] = PayloadSingal.Float64;
      task[TaskIndex.Start] = Uint32View[0];
      task[TaskIndex.End] = Uint32View[1];
      return true
    case "object" : 
      if (args === null) {
        task[TaskIndex.Type] = PayloadSingal.Null
        return true
      }
      if (isThenable(args)) {
        const markedTask = task as Task & { [PromisePayloadMarker]?: true };
        if (markedTask[PromisePayloadMarker] !== true) {
          markedTask[PromisePayloadMarker] = true;
          (args as PromiseLike<unknown>).then(
            (value) => {
              delete markedTask[PromisePayloadMarker];
              task.value = value;
              onPromise?.(task, { status: "fulfilled", value });
            },
            (reason) => {
              delete markedTask[PromisePayloadMarker];
              task.value = reason;
              onPromise?.(task, { status: "rejected", reason });
            },
          );
        }
        return false;
      }

      switch (args.constructor) {
        case Uint8Array: {
          const bytes = (args as Uint8Array).byteLength;
          if (bytes <= staticMaxBytes) {
            const written = writeStaticBinary(args as Uint8Array, slotIndex);
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticBinary;
              task[TaskIndex.PayloadLen] = written;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.Binary;
          if (!reserveDynamic(task, bytes)) return false;
          writeDynamicBinary(args as Uint8Array, task[TaskIndex.Start]);
          return true;
        }
        case Object:
        case Array: {
          const text = stringifyJSON(args)
          let textBytes = 0
          if((text.length * 3) < staticMaxBytes){
            const written = writeStaticUtf8(text, slotIndex);
            task[TaskIndex.Type] = PayloadBuffer.StaticJson;
            task[TaskIndex.PayloadLen] = written;
            return true;
          }

           
          if ((textBytes = utf8ByteLength(text, "utf8")) <= staticMaxBytes) {
            const written = writeStaticUtf8(text, slotIndex);
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticJson;
              task[TaskIndex.PayloadLen] = written;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.Json
          if (!reserveDynamic(task, textBytes)) return false;
          task[TaskIndex.PayloadLen] = writeDynamicUtf8(text, task[TaskIndex.Start])
          return true
        }
        case Map:
        case Set: {
          const binary = serialize(args) as Uint8Array
          if (binary.byteLength <= staticMaxBytes) {
            const written = writeStaticBinary(binary, slotIndex);
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticSerializable;
              task[TaskIndex.PayloadLen] = written;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.Serializable
          if (!reserveDynamic(task, binary.byteLength)) return false;
          writeDynamicBinary(binary, task[TaskIndex.Start])
          return true
        }
        case NumericBuffer: {
          const float64 = (args as NumericBuffer).toFloat64()
          task[TaskIndex.Type] = PayloadBuffer.NumericBuffer
          if (!reserveDynamic(task, float64.byteLength)) return false;
          writeDynamic8Binary(float64, task[TaskIndex.Start])
          return true
        }
        case Int32Array: {
          const view = args as Int32Array;
          const bytes = view.byteLength;
          if (bytes <= staticMaxBytes) {
            const written = writeStaticBinary(
              new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
              slotIndex,
            );
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticInt32Array;
              task[TaskIndex.PayloadLen] = written;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.Int32Array;
          if (!reserveDynamic(task, bytes)) return false;
          writeDynamicBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), task[TaskIndex.Start]);
          return true;
        }
        case Float64Array: {
          const view = args as Float64Array;
          const bytes = view.byteLength;
          if (bytes <= staticMaxBytes) {
            const written = writeStatic8Binary(view, slotIndex);
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticFloat64Array;
              task[TaskIndex.PayloadLen] = written;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.Float64Array;
          if (!reserveDynamic(task, bytes)) return false;
          writeDynamic8Binary(view, task[TaskIndex.Start]);
          return true;
        }
        case BigInt64Array: {
          const view = args as BigInt64Array;
          const bytes = view.byteLength;
          if (bytes <= staticMaxBytes) {
            const written = writeStaticBinary(
              new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
              slotIndex,
            );
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticBigInt64Array;
              task[TaskIndex.PayloadLen] = written;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.BigInt64Array;
          if (!reserveDynamic(task, bytes)) return false;
          writeDynamicBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), task[TaskIndex.Start]);
          return true;
        }
        case BigUint64Array: {
          const view = args as BigUint64Array;
          const bytes = view.byteLength;
          if (bytes <= staticMaxBytes) {
            const written = writeStaticBinary(
              new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
              slotIndex,
            );
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticBigUint64Array;
              task[TaskIndex.PayloadLen] = written;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.BigUint64Array;
          if (!reserveDynamic(task, bytes)) return false;
          writeDynamicBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), task[TaskIndex.Start]);
          return true;
        }
        case DataView: {
          const view = args as DataView;
          const bytes = view.byteLength;
          if (bytes <= staticMaxBytes) {
            const written = writeStaticBinary(
              new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
              slotIndex,
            );
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticDataView;
              task[TaskIndex.PayloadLen] = written;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.DataView;
          if (!reserveDynamic(task, bytes)) return false;
          writeDynamicBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), task[TaskIndex.Start]);
          return true;
        }
        case Error: {
          const err = args as Error;
          const payload = stringifyJSON({
            name: err.name,
            message: err.message,
            stack: err.stack ?? "",
          });
          const bytes = utf8ByteLength(payload, "utf8");
          task[TaskIndex.Type] = PayloadBuffer.Error;
          if (!reserveDynamic(task, bytes)) return false;
          task[TaskIndex.PayloadLen] = writeDynamicUtf8(payload, task[TaskIndex.Start]);
          return true;
        }
        case Date: {
          const time = (args as Date).getTime();
          Float64View[0] = time;
          task[TaskIndex.Type] = PayloadBuffer.Date;
          task[TaskIndex.Start] = Uint32View[0];
          task[TaskIndex.End] = Uint32View[1];
          return true;
        }
      }

      {
        const binary = serialize(args) as Uint8Array
        if (binary.byteLength <= staticMaxBytes) {
          const written = writeStaticBinary(binary, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticSerializable;
            task[TaskIndex.PayloadLen] = written;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.Serializable
        if (!reserveDynamic(task, binary.byteLength)) return false;
        writeDynamicBinary(binary, task[TaskIndex.Start])
        return true
      }
    case "string":
      {
        const text = args as string;
        let textBytes = 0;
        if ((text.length * 3) < staticMaxBytes) {
          const written = writeStaticUtf8(text, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticString;
            task[TaskIndex.PayloadLen] = written;
            return true;
          }
        }

        if ((textBytes = utf8ByteLength(text, "utf8")) <= staticMaxBytes) {
          const written = writeStaticUtf8(text, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticString;
            task[TaskIndex.PayloadLen] = written;
            return true;
          }
        }

        if (textBytes === 0) {
          textBytes = utf8ByteLength(text, "utf8");
        }

        task[TaskIndex.Type] = PayloadBuffer.String
        if (!reserveDynamic(task, textBytes)) return false;
        task[TaskIndex.PayloadLen] =  writeDynamicUtf8(text, task[TaskIndex.Start])
        return true
      }
    case "symbol":
      {
        const key = symbolKeyFor(args);
        if (key === undefined) {
          throw "only Symbol.for(...) keys are supported";
        }
        const textBytes = utf8ByteLength(key, "utf8");
        if (textBytes <= staticMaxBytes) {
          const written = writeStaticUtf8(key, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticSymbol;
            task[TaskIndex.PayloadLen] = written;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.Symbol;
        if (!reserveDynamic(task, textBytes)) return false;
        task[TaskIndex.PayloadLen] = writeDynamicUtf8(key, task[TaskIndex.Start]);
        return true;
      }
    case "undefined":
      task[TaskIndex.Type]  = PayloadSingal.Undefined
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
  const {
    readUtf8: readDynamicUtf8,
    readBytesCopy: readDynamicBytesCopy,
    readBytesView: readDynamicBytesView,
    read8BytesFloatCopy: readDynamic8BytesFloatCopy,
    read8BytesFloatView: readDynamic8BytesFloatView,
  } = createSharedDynamicBufferIO({
    sab,
  });
  const {
    readUtf8: readStaticUtf8,
    readBytesCopy: readStaticBytesCopy,
    readBytesView: readStaticBytesView,
    read8BytesFloatCopy: readStatic8BytesFloatCopy,
  } = requireStaticIO(headersBuffer);


  const HOST_SIDE = host ?? false
  
  // TODO: remove slotIndex and make that all their callers
  // store the slot in their Task, to just get it when it comes 
  // to the static versions of decoding
  return (task: Task, slotIndex: number , specialFlags?: number)=>  {



  switch (task[TaskIndex.Type]) {
    case PayloadSingal.BigInt:
      Uint32View[0] = task[TaskIndex.Start];
      Uint32View[1] = task[TaskIndex.End];
      task.value = BigInt64View[0];
      return;
    case PayloadSingal.True:
      task.value = true;
      return;
    case PayloadSingal.False:
      task.value = false;
      return;
    case PayloadSingal.Float64:
      Uint32View[0] = task[TaskIndex.Start];
      Uint32View[1] = task[TaskIndex.End];
      task.value = Float64View[0];
      return
    case PayloadSingal.Infinity:
      task.value = Infinity
      return
    case PayloadSingal.NaN:
      task.value = NaN
      return
    case PayloadSingal.NegativeInfinity:
      task.value = -Infinity
      return
    case PayloadSingal.Null :
      task.value = null
      return
    case PayloadSingal.Undefined:
      task.value = undefined
      return
    case PayloadBuffer.String:
      task.value = readDynamicUtf8(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      free(task[TaskIndex.slotBuffer])
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
      free(task[TaskIndex.slotBuffer])
    return
    case PayloadBuffer.StaticJson:

      task.value = parseJSON(
        readStaticUtf8(0, task[TaskIndex.PayloadLen], slotIndex)
      )
    return
    case PayloadBuffer.BigInt:
      task.value = decodeBigIntBinary(
        readDynamicBytesCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      free(task[TaskIndex.slotBuffer])
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
      free(task[TaskIndex.slotBuffer])
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
      free(task[TaskIndex.slotBuffer])
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
      free(task[TaskIndex.slotBuffer])
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
      free(task[TaskIndex.slotBuffer])
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
      free(task[TaskIndex.slotBuffer])
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
      free(task[TaskIndex.slotBuffer])
    return
    }
    case PayloadBuffer.StaticDataView: {
      const bytes = readStaticBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
      task.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return
    }
    case PayloadBuffer.Error: {
      const text = readDynamicUtf8(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      const parsed = parseJSON(text) as { name?: string; message?: string; stack?: string }
      const err = new Error(parsed.message ?? "")
      if (parsed.name) err.name = parsed.name
      if (parsed.stack) err.stack = parsed.stack
      task.value = err
      free(task[TaskIndex.slotBuffer])
    return
    }
    case PayloadBuffer.Date:
      Uint32View[0] = task[TaskIndex.Start]
      Uint32View[1] = task[TaskIndex.End]
      task.value = new Date(Float64View[0])
    return
    case PayloadBuffer.Binary:
      task.value = readDynamicBytesCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      free(task[TaskIndex.slotBuffer])
    return
    case PayloadBuffer.StaticBinary:
      task.value = readStaticBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
    return
    case PayloadBuffer.Serializable:
      task.value = deserialize(
        readDynamicBytesView(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      free(task[TaskIndex.slotBuffer])
    return
    case PayloadBuffer.StaticSerializable:
      task.value = deserialize(
        readStaticBytesView(0, task[TaskIndex.PayloadLen], slotIndex)
      )
    return
    case PayloadBuffer.NumericBuffer:
      task.value = NumericBuffer.fromFloat64(
        readDynamic8BytesFloatView(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      free(task[TaskIndex.slotBuffer])
    return
    case PayloadSingal.UNREACHABLE:
      throw "UREACHABLE AT RECOVER"
  }
} 
}
