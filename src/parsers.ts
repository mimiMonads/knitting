import type { External, Serializable } from "./taskApi.ts";
import { type SignalArguments } from "./signals.ts";
import type { MainList, QueueListWorker } from "./mainQueueManager.ts";
import { deserialize, serialize } from "node:v8";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;

enum PayloadType {
  Serializable = 0,
  String = 1,
  BigUint = 2,
  BigInt = 3,
  True = 4,
  False = 5,
  Undefined = 6,
  NaN = 7,
  Infinity = 8,
  NegativeInfinity = 9,
  Float64 = 10,
  Uint32 = 11,
  Int32 = 12,
  Uint64 = 13,
  Int64 = 14,
  Null = 15,
  Json = 16,
}

const toWorkerUint8 = ({ id, setBuffer }: SignalArguments) =>
(
  task: MainList,
) => {
  setBuffer(task[1]);
  id[0] = task[0];
};

const toWorkerSerializable = ({ id, setBuffer }: SignalArguments) =>
(
  task: MainList,
) => {
  setBuffer(serialize(task[1]));
  id[0] = task[0];
};

const toWorkerString = ({ id, setBuffer }: SignalArguments) =>
(
  task: MainList,
) => {
  // @ts-ignore
  const encode = textEncoder.encode(task[1]);
  setBuffer(encode);
  id[0] = task[0];
};

const toWorkerVoid =
  ({ id, payloadLength }: SignalArguments) => (task: MainList) => {
    payloadLength[0] = 0;
    id[0] = task[0];
  };

const fromReturnToMainError = ({
  type,
  id,
  setBuffer,
}: SignalArguments) => {
  const serilizedError = serialize(
    new Error("The thrown object is not serializable"),
  );

  return (task: MainList) => {
    let error: Serializable;

    try {
      error = serialize(task[3]);
    } catch (_) {
      error = serilizedError;
    }

    setBuffer(error as Uint8Array);
    id[0] = task[0];

    // To be parsed with serialize
    type[0] = PayloadType.Serializable;
  };
};

/**
 * Where:
 *  1 -> Takes the arguments of a MainList
 *  3 -> Takes the return of a MainList
 */
const toWorkerAny = (index: 1 | 3 = 1) =>
(
  {
    id,
    type,
    uBigInt,
    bigInt,
    int32,
    uInt32,
    float64,
    setBuffer,
  }: SignalArguments,
) =>
(
  task: MainList<Serializable, Serializable>,
) => {
  const args = task[index];
  id[0] = task[0];

  switch (typeof args) {
    case "string": {
      const encode = textEncoder.encode(args);
      setBuffer(encode);
      type[0] = PayloadType.String;
      return;
    }

    case "bigint": {
      if (args > 0n) {
        uBigInt[0] = args;
        type[0] = PayloadType.BigUint;
        return;
      }
      bigInt[0] = args;
      type[0] = PayloadType.BigInt;
      return;
    }

    case "boolean": {
      type[0] = args === true ? PayloadType.True : PayloadType.False;
      return;
    }

    case "undefined": {
      type[0] = PayloadType.Undefined;
      return;
    }

    case "number": {
      if (args !== args) {
        type[0] = PayloadType.NaN;
        return;
      }

      switch (args) {
        case Infinity:
          type[0] = PayloadType.Infinity;
          return;
        case -Infinity:
          type[0] = PayloadType.NegativeInfinity;
          return;
      }

      if (args % 1 === 0) {
        if (args > 0) {
          if (args <= 0xFFFFFFFF) {
            uInt32[0] = args;
            type[0] = PayloadType.Uint32;
            return;
          }
          if (args <= MAX_SAFE_INTEGER) {
            uBigInt[0] = BigInt(args);
            type[0] = PayloadType.Uint64;
            return;
          }
          float64[0] = args;
          type[0] = PayloadType.Float64;
          return;
        }

        if (args >= -0x80000000) {
          int32[0] = args;
          type[0] = PayloadType.Int32;
          return;
        } else if (args >= MIN_SAFE_INTEGER) {
          bigInt[0] = BigInt(args);
          type[0] = PayloadType.Int64;
          return;
        }
      }

      float64[0] = args;
      type[0] = PayloadType.Float64;
      return;
    }

    case "object": {
      if (args === null) {
        type[0] = PayloadType.Null;
        return;
      }

      switch (args.constructor) {
        case Object:
        case Array: {
          setBuffer(textEncoder.encode(JSON.stringify(args)));

          type[0] = PayloadType.Json;
          return;
        }
      }

      setBuffer(serialize(args) as Uint8Array);
      type[0] = PayloadType.Serializable;
      return;
    }
  }
};

const sendToWorker = (signals: SignalArguments) => (type: External) => {
  switch (type) {
    case "uint8":
      return toWorkerUint8(signals);
    case "string":
      return toWorkerString(signals);
    case "void":
      return toWorkerVoid(signals);
    case "number[]":
      return toWorkerSerializable(signals);
    case "serializable":
      return toWorkerAny(1)(signals);
  }
};

const readUint8FromWorker = ({ slice, payloadLength }: SignalArguments) => () =>
  slice(0, payloadLength[0]);

const readStringFromWorker =
  ({ slice, payloadLength }: SignalArguments) => () =>
    textDecoder.decode(slice(0, payloadLength[0]));

const readVoidFromWorker = ({}: SignalArguments) => () => undefined;

const readSerializableFromWorker =
  ({ subarray, payloadLength }: SignalArguments) => () =>
    deserialize(subarray(0, payloadLength[0]));

const readFromWorker = (signals: SignalArguments) => (type: External) => {
  switch (type) {
    case "uint8":
      return readUint8FromWorker(signals);
    case "string":
      return readStringFromWorker(signals);
    case "void":
      return readVoidFromWorker(signals);
    case "number[]":
      return readSerializableFromWorker(signals);
    case "serializable":
      return readPayloadWorkerAny(signals);
  }
};

///  WORKER ///

const readPayloadWorkerUint8 =
  ({ slice, payloadLength }: SignalArguments) => () =>
    slice(0, payloadLength[0]);

const readPayloadWorkerString =
  ({ subarray, payloadLength }: SignalArguments) => () =>
    textDecoder.decode(subarray(0, payloadLength[0]));

const readPayloadWorkerVoid = ({}: SignalArguments) => () => undefined;

const readPayloadWorkerSerializable =
  ({ subarray, payloadLength }: SignalArguments) => () =>
    deserialize(subarray(0, payloadLength[0]));

const readPayloadWorkerAny = (
  {
    payloadLength,
    subarray,
    type,
    uBigInt,
    bigInt,
    uInt32,
    int32,
    float64,
  }: SignalArguments,
) =>
() => {
  switch (type[0]) {
    case PayloadType.String:
      return textDecoder.decode(
        subarray(0, payloadLength[0]),
      );
    case PayloadType.BigUint:
      return uBigInt[0];
    case PayloadType.BigInt:
      return bigInt[0];
    case PayloadType.True:
      return true;
    case PayloadType.False:
      return false;
    case PayloadType.Undefined:
      return undefined;
    case PayloadType.NaN:
      return NaN;
    case PayloadType.Infinity:
      return Infinity;
    case PayloadType.NegativeInfinity:
      return -Infinity;
    case PayloadType.Float64:
      return float64[0];
    case PayloadType.Uint32:
      return uInt32[0];
    case PayloadType.Int32:
      return int32[0];
    case PayloadType.Uint64:
      return Number(uBigInt[0]);
    case PayloadType.Int64:
      return Number(bigInt[0]);
    case PayloadType.Null:
      return null;
    case PayloadType.Json:
      return JSON.parse(
        textDecoder.decode(
          subarray(0, payloadLength[0]),
        ),
      );
    // default
    case PayloadType.Serializable:
      return deserialize(subarray(0, payloadLength[0]));
  }
};

const fromPlayloadToArguments =
  (signals: SignalArguments) => (type: External) => {
    switch (type) {
      case "uint8":
        return readPayloadWorkerUint8(signals);
      case "string":
        return readPayloadWorkerString(signals);
      case "void":
        return readPayloadWorkerVoid(signals);
      case "number[]":
        return readPayloadWorkerSerializable(signals);
      case "serializable":
        return readPayloadWorkerAny(signals);
    }
  };

const writePayloadUnint8 =
  ({ id, setBuffer }: SignalArguments) => (task: QueueListWorker) => {
    setBuffer(task[3]);
    id[0] = task[0];
  };

const writePayloadString =
  ({ id, setBuffer }: SignalArguments) => (task: QueueListWorker) => {
    // @ts-ignore
    const encode = textEncoder.encode(task[3]);
    setBuffer(encode);
    id[0] = task[0];
  };

const writePayloadVoid =
  ({ id }: SignalArguments) => (task: QueueListWorker) => {
    // No payload needed
    id[0] = task[0];
  };

const writePayloadSerializable = ({ id, setBuffer }: SignalArguments) =>
(
  task: QueueListWorker,
) => {
  const encoded = serialize(task[3]);
  setBuffer(encoded);
  id[0] = task[0];
};

const fromreturnToMain = (signals: SignalArguments) => (type: External) => {
  switch (type) {
    case "uint8":
      return writePayloadUnint8(signals);
    case "string":
      return writePayloadString(signals);
    case "void":
      return writePayloadVoid(signals);
    case "number[]":
      return writePayloadSerializable(signals);
    case "serializable":
      return toWorkerAny(3)(signals);
  }
};

const readPayloadUWU = ({ subarray, payloadLength }: SignalArguments) => () =>
  deserialize(subarray(0, payloadLength[0]));

export {
  fromPlayloadToArguments,
  fromreturnToMain,
  fromReturnToMainError,
  readFromWorker,
  readPayloadUWU,
  sendToWorker,
};
