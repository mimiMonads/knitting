import { LockBound, PayloadBuffer, PayloadSingal, type Task, TaskIndex } from "./lock.ts";
import { register } from "./regionRegistry.ts"
import { createSharedDynamicBufferIO, createSharedStaticBufferIO } from "./createSharedBufferIO.ts"
import { deserialize, serialize } from "node:v8";
import { NumericBuffer } from "../ipc/protocol/parsers/NumericBuffer.ts";

const memory = new ArrayBuffer(8);
const Float64View = new Float64Array(memory);
const UBigInt64View = new BigUint64Array(memory);
const Uint32View = new Uint32Array(memory);

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
 * 
 * Returns `true` if requieres a buffer
 * 
 */

export const encodePayload = ({
  lockSector,
  sab,
  headersBuffer
}: {
  lockSector?: SharedArrayBuffer;
   sab?: SharedArrayBuffer;
   headersBuffer: Uint32Array 
}  ) =>  { 
  
  const registry = register({
    lockSector
  })
  const io = createSharedDynamicBufferIO({
    sab
  })
  const staticIO = initStaticIO(headersBuffer);
  const staticMaxChars = staticIO?.maxBytes ? staticIO.maxBytes * 2 : 0;

  return(task: Task, slotIndex: number) => {
  const args = task.value
  switch (typeof args) {
    case "bigint":
      UBigInt64View[0] = args;
      task[TaskIndex.Type] = PayloadSingal.BigInt;
      task[TaskIndex.Start] = Uint32View[0];
      task[TaskIndex.End] = Uint32View[1];
      return false;
    case "boolean":
      task[TaskIndex.Type] =
        task.value === true ? PayloadSingal.True : PayloadSingal.False;
      return false;
    case "function":
      throw "you cant pass a function ";
    case "number":

    if (args !== args) {
      task[TaskIndex.Type] = PayloadSingal.NaN;
      return false;
    }
    switch (args) {
      case Infinity:
        task[TaskIndex.Type]  = PayloadSingal.Infinity;
        return false;
      case -Infinity:
        task[TaskIndex.Type]  = PayloadSingal.NegativeInfinity;
        return false;
    }

      Float64View[0] = args;
      task[TaskIndex.Type] = PayloadSingal.Float64;
      task[TaskIndex.Start] = Uint32View[0];
      task[TaskIndex.End] = Uint32View[1];
      return false
    case "object" : 
      if (args === null) {
        task[TaskIndex.Type] = PayloadSingal.Null
        return false
      }

      switch (args.constructor) {
        case Object:
        case Array: {
          const text = JSON.stringify(args)
          if (staticIO && text.length <= staticMaxChars) {
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
          task[TaskIndex.PayloadLen] = text.length * 3
          registry.allocTask(task)
          task[TaskIndex.PayloadLen] = io.writeUtf8(text, task[TaskIndex.Start])
          return true
        }
        case Map:
        case Set: {
          const binary = serialize(args) as Uint8Array
          task[TaskIndex.Type] = PayloadBuffer.Serializable
          task[TaskIndex.PayloadLen] = binary.byteLength
          registry.allocTask(task)
          io.writeBinary(binary, task[TaskIndex.Start])
          return true
        }
        case NumericBuffer: {
          const float64 = (args as NumericBuffer).toFloat64()
          task[TaskIndex.Type] = PayloadBuffer.NumericBuffer
          task[TaskIndex.PayloadLen] = float64.byteLength
          registry.allocTask(task)
          io.write8Binary(float64, task[TaskIndex.Start])
          return true
        }
      }

      {
        const binary = serialize(args) as Uint8Array
        task[TaskIndex.Type] = PayloadBuffer.Serializable
        task[TaskIndex.PayloadLen] = binary.byteLength
        registry.allocTask(task)
        io.writeBinary(binary, task[TaskIndex.Start])
        return true
      }
    case "string":
      if (staticIO && args.length <= staticMaxChars) {
        const written = staticIO.writeUtf8(args as string, slotIndex);
        if (written !== -1) {
          task[TaskIndex.Type] = PayloadBuffer.StaticString;
          task[TaskIndex.PayloadLen] = written;
          task[TaskIndex.Start] = 0;
          task[TaskIndex.End] = 0;
          return true;
        }
      }

      task[TaskIndex.Type] = PayloadBuffer.String
      task[TaskIndex.PayloadLen] = args.length * 3
      registry.allocTask(task)
      task[TaskIndex.PayloadLen] =  io.writeUtf8(args as string , task[TaskIndex.Start])
      return true
    case "symbol":
      throw "notImplemented yet"
    case "undefined":
      task[TaskIndex.Type]  = PayloadSingal.Undefined
      return false
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
      task.value = UBigInt64View[0];
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
