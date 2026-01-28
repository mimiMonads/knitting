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

const isThenable = (value: unknown): value is PromiseLike<unknown> => {
  if (value == null) return false;
  const type = typeof value;
  if (type !== "object" && type !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
};

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
  const slotStride = LockBound.padding + TaskIndex.TotalBuff;
  const slotOffset = (at: number) => (at * slotStride) + LockBound.padding;
  const slotStartBytes = (at: number) =>
    (slotOffset(at) + TaskIndex.Size) * u32Bytes;
  const writableBytes = (TaskIndex.TotalBuff - TaskIndex.Size) * u32Bytes;
  const requiredBytes = slotStartBytes(LockBound.slots - 1) + writableBytes;

  if (headersBuffer.byteLength < requiredBytes) return null;

  return createSharedStaticBufferIO({
    headersBuffer: headersBuffer.buffer as SharedArrayBuffer,
  });
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
  
  const registry = register({
    lockSector
  })
  const io = createSharedDynamicBufferIO({
    sab
  })
  const staticIO = initStaticIO(headersBuffer);

  const reserveDynamic = (task: Task, bytes: number) => {
    task[TaskIndex.PayloadLen] = bytes;
    if (registry.allocTask(task) === -1) return false;
    return true;
  };

  return (task: Task, slotIndex: number) => {
  const args = task.value
  switch (typeof args) {
    case "bigint":
      if (args < BIGINT64_MIN || args > BIGINT64_MAX) {
        const binary = encodeBigIntBinary(args);
        if (staticIO && binary.byteLength <= staticIO.maxBytes) {
          const written = staticIO.writeBinary(binary, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticBigInt;
            task[TaskIndex.PayloadLen] = written;
            task[TaskIndex.Start] = 0;
            task[TaskIndex.End] = 0;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.BigInt;
        if (!reserveDynamic(task, binary.byteLength)) return false;
        io.writeBinary(binary, task[TaskIndex.Start])
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
          if (staticIO && bytes <= staticIO.maxBytes) {
            const written = staticIO.writeBinary(args as Uint8Array, slotIndex);
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticBinary;
              task[TaskIndex.PayloadLen] = written;
              task[TaskIndex.Start] = 0;
              task[TaskIndex.End] = 0;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.Binary;
          if (!reserveDynamic(task, bytes)) return false;
          io.writeBinary(args as Uint8Array, task[TaskIndex.Start]);
          return true;
        }
        case Object:
        case Array: {
          const text = JSON.stringify(args)
          const textBytes = Buffer.byteLength(text, "utf8");
          if (staticIO && textBytes <= staticIO.maxBytes) {
            const written = staticIO.writeUtf8(text, slotIndex);
            if (written !== -1) {
              task[TaskIndex.Type] = PayloadBuffer.StaticJson;
              task[TaskIndex.PayloadLen] = written;
              task[TaskIndex.Start] = 0;
              task[TaskIndex.End] = 0;
              return true;
            }
          }

          task[TaskIndex.Type] = PayloadBuffer.Json
          if (!reserveDynamic(task, textBytes)) return false;
          task[TaskIndex.PayloadLen] = io.writeUtf8(text, task[TaskIndex.Start])
          return true
        }
        case Map:
        case Set: {
          const binary = serialize(args) as Uint8Array
          task[TaskIndex.Type] = PayloadBuffer.Serializable
          if (!reserveDynamic(task, binary.byteLength)) return false;
          io.writeBinary(binary, task[TaskIndex.Start])
          return true
        }
        case NumericBuffer: {
          const float64 = (args as NumericBuffer).toFloat64()
          task[TaskIndex.Type] = PayloadBuffer.NumericBuffer
          if (!reserveDynamic(task, float64.byteLength)) return false;
          io.write8Binary(float64, task[TaskIndex.Start])
          return true
        }
        case Int32Array: {
          const view = args as Int32Array;
          const bytes = view.byteLength;
          task[TaskIndex.Type] = PayloadBuffer.Int32Array;
          if (!reserveDynamic(task, bytes)) return false;
          io.writeBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), task[TaskIndex.Start]);
          return true;
        }
        case Float64Array: {
          const view = args as Float64Array;
          const bytes = view.byteLength;
          task[TaskIndex.Type] = PayloadBuffer.Float64Array;
          if (!reserveDynamic(task, bytes)) return false;
          io.write8Binary(view, task[TaskIndex.Start]);
          return true;
        }
        case BigInt64Array: {
          const view = args as BigInt64Array;
          const bytes = view.byteLength;
          task[TaskIndex.Type] = PayloadBuffer.BigInt64Array;
          if (!reserveDynamic(task, bytes)) return false;
          io.writeBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), task[TaskIndex.Start]);
          return true;
        }
        case BigUint64Array: {
          const view = args as BigUint64Array;
          const bytes = view.byteLength;
          task[TaskIndex.Type] = PayloadBuffer.BigUint64Array;
          if (!reserveDynamic(task, bytes)) return false;
          io.writeBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), task[TaskIndex.Start]);
          return true;
        }
        case DataView: {
          const view = args as DataView;
          const bytes = view.byteLength;
          task[TaskIndex.Type] = PayloadBuffer.DataView;
          if (!reserveDynamic(task, bytes)) return false;
          io.writeBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), task[TaskIndex.Start]);
          return true;
        }
        case Error: {
          const err = args as Error;
          const payload = JSON.stringify({
            name: err.name,
            message: err.message,
            stack: err.stack ?? "",
          });
          const bytes = Buffer.byteLength(payload, "utf8");
          task[TaskIndex.Type] = PayloadBuffer.Error;
          if (!reserveDynamic(task, bytes)) return false;
          task[TaskIndex.PayloadLen] = io.writeUtf8(payload, task[TaskIndex.Start]);
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
        task[TaskIndex.Type] = PayloadBuffer.Serializable
        if (!reserveDynamic(task, binary.byteLength)) return false;
        io.writeBinary(binary, task[TaskIndex.Start])
        return true
      }
    case "string":
      {
        const text = args as string;
        const textBytes = Buffer.byteLength(text, "utf8");
        if (staticIO && textBytes <= staticIO.maxBytes) {
          const written = staticIO.writeUtf8(text, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticString;
            task[TaskIndex.PayloadLen] = written;
            task[TaskIndex.Start] = 0;
            task[TaskIndex.End] = 0;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.String
        if (!reserveDynamic(task, textBytes)) return false;
        task[TaskIndex.PayloadLen] =  io.writeUtf8(text, task[TaskIndex.Start])
        return true
      }
    case "symbol":
      {
        const key = Symbol.keyFor(args);
        if (key === undefined) {
          throw "only Symbol.for(...) keys are supported";
        }
        const textBytes = Buffer.byteLength(key, "utf8");
        if (staticIO && textBytes <= staticIO.maxBytes) {
          const written = staticIO.writeUtf8(key, slotIndex);
          if (written !== -1) {
            task[TaskIndex.Type] = PayloadBuffer.StaticSymbol;
            task[TaskIndex.PayloadLen] = written;
            task[TaskIndex.Start] = 0;
            task[TaskIndex.End] = 0;
            return true;
          }
        }

        task[TaskIndex.Type] = PayloadBuffer.Symbol;
        if (!reserveDynamic(task, textBytes)) return false;
        task[TaskIndex.PayloadLen] = io.writeUtf8(key, task[TaskIndex.Start]);
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
  
  const registry = register({
    lockSector
  })
  const io = createSharedDynamicBufferIO({
    sab
  })
  const staticIO = initStaticIO(headersBuffer);


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
      task.value = io.readUtf8(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    case PayloadBuffer.StaticString:
  
      task.value = staticIO!.readUtf8(0, task[TaskIndex.PayloadLen], slotIndex)
    return
    case PayloadBuffer.Json:
      task.value = JSON.parse(
        io.readUtf8(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    case PayloadBuffer.StaticJson:

      task.value = JSON.parse(
        staticIO!.readUtf8(0, task[TaskIndex.PayloadLen], slotIndex)
      )
    return
    case PayloadBuffer.BigInt:
      task.value = decodeBigIntBinary(
        io.readBytesCopy(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    case PayloadBuffer.StaticBigInt:
      task.value = decodeBigIntBinary(
        staticIO!.readBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
      )
    return
    case PayloadBuffer.Symbol:
      task.value = Symbol.for(
        io.readUtf8(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    case PayloadBuffer.StaticSymbol:
      task.value = Symbol.for(
        staticIO!.readUtf8(0, task[TaskIndex.PayloadLen], slotIndex)
      )
    return
    case PayloadBuffer.Int32Array: {
      const bytes = io.readBytesCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      task.value = new Int32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 2
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    }
    case PayloadBuffer.Float64Array: {
      task.value = io.read8BytesFloatCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    }
    case PayloadBuffer.BigInt64Array: {
      const bytes = io.readBytesCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      task.value = new BigInt64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 3
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    }
    case PayloadBuffer.BigUint64Array: {
      const bytes = io.readBytesCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      task.value = new BigUint64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength >>> 3
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    }
    case PayloadBuffer.DataView: {
      const bytes = io.readBytesCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      task.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      registry.free(task[TaskIndex.slotBuffer])
    return
    }
    case PayloadBuffer.Error: {
      const text = io.readUtf8(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      const parsed = JSON.parse(text) as { name?: string; message?: string; stack?: string }
      const err = new Error(parsed.message ?? "")
      if (parsed.name) err.name = parsed.name
      if (parsed.stack) err.stack = parsed.stack
      task.value = err
      registry.free(task[TaskIndex.slotBuffer])
    return
    }
    case PayloadBuffer.Date:
      Uint32View[0] = task[TaskIndex.Start]
      Uint32View[1] = task[TaskIndex.End]
      task.value = new Date(Float64View[0])
    return
    case PayloadBuffer.Binary:
      task.value = io.readBytesCopy(
        task[TaskIndex.Start],
        task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    case PayloadBuffer.StaticBinary:
      task.value = staticIO!.readBytesCopy(0, task[TaskIndex.PayloadLen], slotIndex)
    return
    case PayloadBuffer.Serializable:
      task.value = deserialize(
        io.readBytesView(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    case PayloadBuffer.NumericBuffer:
      task.value = NumericBuffer.fromFloat64(
        io.read8BytesFloatView(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      registry.free(task[TaskIndex.slotBuffer])
    return
    case PayloadSingal.UNREACHABLE:
      throw "UREACHABLE AT RECOVER"
  }
} 
}
