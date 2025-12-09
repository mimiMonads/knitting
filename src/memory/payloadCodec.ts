import { PayloadSingal, type Task, TaskIndex } from "./lock.ts";


const memory = new ArrayBuffer(8);
const Float64View = new Float64Array(memory);
const UBigInt64View = new BigUint64Array(memory);
const Uint32View = new Uint8Array(memory);


export const encodePayload = (task: Task) => {
  const args = task.value
  switch (typeof args) {
    case "bigint":
      UBigInt64View[0] = args;
      task[TaskIndex.Type] = PayloadSingal.BigInt;
      task[TaskIndex.Start] = Uint32View[0];
      task[TaskIndex.End] = Uint32View[1];
      return;
    case "boolean":
      task[TaskIndex.Type] =
        task.value === true ? PayloadSingal.True : PayloadSingal.False;
      return;
    case "function":
      throw "you cant pass a function ";
    case "number":

    if (args !== args) {
      task[TaskIndex.Type] = PayloadSingal.NaN;
      return;
    }
    switch (args) {
      case Infinity:
        task[TaskIndex.Type]  = PayloadSingal.Infinity;
        return;
      case -Infinity:
        task[TaskIndex.Type]  = PayloadSingal.NegativeInfinity;
        return;
    }

      Float64View[0] = args;
      task[TaskIndex.Type] = PayloadSingal.Float64;
      task[TaskIndex.Start] = Uint32View[0];
      task[TaskIndex.End] = Uint32View[1];
      return
    case "object" : 
      throw "notImplemented yet"
    case "string":
      throw "notImplemented yet"
    case "symbol":
      throw "notImplemented yet"
    case "undefined":
      task[TaskIndex.Type]  = PayloadSingal.Undefined
      return
  }
};

export const decodePayload = (task: Task) => {
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
    case PayloadSingal.UNREACHABLE:
      throw "UREACHABLE AT RECOVER"
  }
};