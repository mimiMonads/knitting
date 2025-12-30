import { PayloadBuffer, PayloadSingal, type Task, TaskIndex  } from "./lock.ts";
import { register } from "./regionRegistry.ts"
import { createSharedDynamicBufferIO } from "./createSharedBufferIO.ts"
import { deserialize, serialize } from "node:v8";
import { NumericBuffer } from "../ipc/protocol/parsers/NumericBuffer.ts";

const memory = new ArrayBuffer(8);
const Float64View = new Float64Array(memory);
const UBigInt64View = new BigUint64Array(memory);
const Uint32View = new Uint32Array(memory);


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

  return(task: Task) => {
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
  sab
}: {
  lockSector?: SharedArrayBuffer;
   sab?: SharedArrayBuffer; 
   headersBuffer: Uint32Array 
}  ) => {
  
    const registry = register({
    lockSector
  })
  const io = createSharedDynamicBufferIO({
    sab
  })
  
  return (task: Task)=>  {

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
    case PayloadBuffer.Json:
      task.value = JSON.parse(
        io.readUtf8(
          task[TaskIndex.Start],
          task[TaskIndex.Start] + task[TaskIndex.PayloadLen]
        )
      )
      registry.free(task[TaskIndex.slotBuffer])
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
