import type { External, Serializable } from "./taskApi.ts";
import { type SignalArguments } from "./signals.ts";
import type { MainList, QueueListWorker } from "./mainQueueManager.ts";
import { deserialize, serialize } from "node:v8";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
const toWorkerUint8 =
  ({ id, payload, payloadLength, grow }: SignalArguments) =>
  (
    task: MainList,
  ) => {
    payload.set(task[1]);
    payloadLength[0] = grow(task[1].length);
    id[0] = task[0];
  };

const toWorkerSerializable =
  ({ id, buffer, payloadLength, grow }: SignalArguments) =>
  (
    task: MainList,
  ) => {
    const encoded = serialize(task[1]);

    //@ts-ignore
    buffer.set(encoded);
    //@ts-ignore
    payloadLength[0] = grow(encoded.length);

    id[0] = task[0];
  };

const toWorkerString =
  ({ id, payload, payloadLength, grow }: SignalArguments) =>
  (
    task: MainList,
  ) => {
    //@ts-ignore
    const encode = textEncoder.encode(task[1]);
    payload.set(encode);
    payloadLength[0] = grow(encode.length);
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
  buffer,
  payloadLength,
  grow,
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

    buffer.set(error as Uint8Array);
    //@ts-ignore
    payloadLength[0] = grow(error.length);
    id[0] = task[0];
    // To be parsed with serialize
    type[0] = 0;
  };
};

/**
 * Where:
 *  1 -> Takes the arguments of a MainList
 *  3 -> Takes the retun of a MainList
 */
const toWorkerAny = (index: 1 | 3 = 1) =>
(
  {
    id,
    payload,
    payloadLength,
    type,
    uBigInt,
    bigInt,
    int32,
    uInt32,
    float64,
    grow,
  }: SignalArguments,
) =>
(
  task: MainList<Serializable, Serializable>,
) => {
  const args = task[index];
  id[0] = task[0];

  switch (typeof args) {
    /**
     * string -> 1
     */
    case "string": {
      const encode = textEncoder.encode(args);

      payload.set(encode);
      payloadLength[0] = grow(encode.length);
      type[0] = 1;

      return;
    }
    /**
     * bigInt -> 2 & 3
     *  2 = uBigInt
     *  3 = bigInt
     */
    case "bigint": {
      if (args > 0n) {
        uBigInt[0] = args;
        type[0] = 2;
        return;
      }
      bigInt[0] = args;
      type[0] = 3;
      return;
    }

    /**
     * Boolean -> 4 & 5
     *  4 = true
     *  5 = false
     */

    case "boolean": {
      type[0] = args === true ? 4 : 5;
      return;
    }

    /**
     * undefined -> 6
     */

    case "undefined": {
      type[0] = 6;
      return;
    }

    /**
     * number -> 7 <-> 14
     * NaN = 7
     * Infinity = 8
     * - Infinity = 9
     * Float64 = 10
     * Uint32 = 11
     * Int32 = 12
     * Uint64 = 13
     * Int64 = 14
     */
    case "number": {
      if (args !== args) {
        type[0] = 7;
        return;
      }

      switch (args) {
        case Infinity:
          type[0] = 8;
          return;

        case -Infinity:
          type[0] = 9;

          return;
      }

      if (args % 1 === 0) {
        if (args > 0) {
          if (args <= 0xFFFFFFFF) {
            uInt32[0] = args;
            type[0] = 11;
            return;
          }

          if (args <= MAX_SAFE_INTEGER) {
            uBigInt[0] = BigInt(args);
            type[0] = 13;
            return;
          }

          float64[0] = args;
          type[0] = 10;
          return;
        }

        if (args >= -0x80000000) {
          int32[0] = args;
          type[0] = 12;
          return;
        } else if (args >= MIN_SAFE_INTEGER) {
          bigInt[0] = BigInt(args);
          type[0] = 14;
          return;
        }
      }

      float64[0] = args;
      type[0] = 10;
      return;
    }
    /**
     * Object 15
     * null = 15
     */
    case "object": {
      let encoded;
      if (args === null) {
        type[0] = 15;
        return;
      }

      if (args.constructor === Object || args.constructor === Array) {
        encoded = textEncoder.encode(JSON.stringify(args));
        payload.set(encoded);
        payloadLength[0] = grow(encoded.length);
        type[0] = 16;
        return;
      }

      encoded = serialize(args);
      //@ts-ignore
      payload.set(encoded);
      //@ts-ignore
      payloadLength[0] = grow(encoded.length);
      type[0] = 0;
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

const readUint8FromWorker =
  ({ payload, payloadLength }: SignalArguments) => () =>
    payload.slice(0, payloadLength[0]);

const readStringFromWorker =
  ({ payload, payloadLength }: SignalArguments) => () =>
    textDecoder.decode(payload.slice(0, payloadLength[0]));

const readVoidFromWorker = ({}: SignalArguments) => () => undefined;

const readSerializableFromWorker =
  ({ buffer, payloadLength }: SignalArguments) => () => {
    return deserialize(buffer.subarray(0, payloadLength[0]));
  };

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
  ({ payload, payloadLength }: SignalArguments) => () =>
    payload.slice(0, payloadLength[0]);

const readPayloadWorkerString =
  ({ payload, payloadLength }: SignalArguments) => () =>
    textDecoder.decode(payload.subarray(0, payloadLength[0]));

const readPayloadWorkerVoid = ({}: SignalArguments) => () => undefined;

const readPayloadWorkerSerializable =
  ({ buffer, payloadLength }: SignalArguments) => () => {
    return deserialize(buffer.subarray(0, payloadLength[0]));
  };

const readPayloadWorkerAny = (
  {
    buffer,
    payloadLength,
    payload,
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
    /**
     * String case
     */

    case 1:
      return textDecoder.decode(
        payload.subarray(0, payloadLength[0]),
      );
    /**
     * BigUint case
     */
    case 2:
      return uBigInt[0];
      /**
       * BigInt case
       */
    case 3:
      return bigInt[0];
    case 4:
      return true;
    case 5:
      return false;
    case 6:
      return undefined;
      /**
       * number -> 7 & 8 & 9 & 10
       * NaN = 7
       * Infinity = 8
       * - Infinity = 9
       * Float64 = 10
       * Uint32 = 11
       * Int32 = 12
       * Uint64 = 13
       * Int64 = 14
       */
    case 7:
      return NaN;
    case 8:
      return Infinity;
    case 9:
      return -Infinity;
    case 10:
      return float64[0];
    case 11:
      return uInt32[0];
    case 12:
      return int32[0];
    case 13:
      return Number(uBigInt[0]);
    case 14:
      return Number(bigInt[0]);
    case 15:
      return null;
    case 16:
      return JSON.parse(
        textDecoder.decode(
          payload.subarray(0, payloadLength[0]),
        ),
      );
    //default
    case 0:
      return deserialize(buffer.subarray(0, payloadLength[0]));
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
  ({ id, payload, payloadLength, grow }: SignalArguments) =>
  (task: QueueListWorker) => {
    payload.set(task[3], 0);
    payloadLength[0] = grow(task[3].length);
    id[0] = task[0];
  };

const writePayloadString =
  ({ id, payload, payloadLength, grow }: SignalArguments) =>
  (task: QueueListWorker) => {
    //@ts-ignore
    const encode = textEncoder.encode(task[3]);
    payload.set(encode, 0);
    payloadLength[0] = grow(encode.length);
    id[0] = task[0];
  };

const writePayloadVoid =
  ({ id }: SignalArguments) => (task: QueueListWorker) => {
    // No payload needed
    id[0] = task[0];
  };

const writePayloadSerializable =
  ({ id, buffer, payloadLength, grow }: SignalArguments) =>
  (
    task: QueueListWorker,
  ) => {
    const encoded = serialize(task[3]);
    //@ts-ignore
    buffer.set(encoded);
    //@ts-ignore
    payloadLength[0] = grow(encoded.length);
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

const readPayloadUWU =
  ({ buffer, payloadLength, grow }: SignalArguments) => () => {
    return deserialize(buffer.subarray(0, grow(payloadLength[0])));
  };

export {
  fromPlayloadToArguments,
  fromreturnToMain,
  fromReturnToMainError,
  readFromWorker,
  readPayloadUWU,
  sendToWorker,
};
