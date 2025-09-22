import {
  frameFlagsFlag,
  OP,
  type SignalArguments,
} from "../transport/shared-memory.ts";
import type { MainList } from "../../runtime/tx-queue.ts";
import { MainListEnum } from "../../runtime/tx-queue.ts";

import { NumericBuffer } from "./parsers/NumericBuffer.ts";

import { deserialize, serialize } from "node:v8";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;

export enum PayloadType {
  UNREACHABLE = 0,
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
  Uint8Array = 17,
  Serializable = 18,
  StringToJson = 19,
  SerializabledAndReady = 20,
  NumericBuffer = 21,
  NumericBufferParsed = 22,
}

const fromReturnToMainError = ({
  type,
  writeBinary,
}: SignalArguments) => {
  const serializedError = serialize(
    new Error("The thrown object is not serializable"),
  );

  return (task: MainList) => {
    let error: unknown;

    try {
      error = serialize(task[MainListEnum.WorkerResponse]);
    } catch (_) {
      error = serializedError;
    }

    writeBinary(error as unknown as Uint8Array);

    type[0] = PayloadType.Serializable;
  };
};

type PossibleIndexes = MainListEnum.RawArguments | MainListEnum.WorkerResponse;

const preencodeJsonString = (
  { index }: {
    index: PossibleIndexes;
  },
) => {
  const at = index;

  return (task: MainList) => {
    const args = task[at];

    if (typeof args === "object") {
      if (args === null) return task;

      switch (args.constructor) {
        case Array:
        case Object: {
          task[at] = JSON.stringify(args);
          task[MainListEnum.PayloadType] = PayloadType.StringToJson;
          return task;
        }
        case Map:
        case Set: {
          task[at] = serialize(args);
          task[MainListEnum.PayloadType] = PayloadType.SerializabledAndReady;
          return task;
        }
        case NumericBuffer: {
          task[at] = (args as NumericBuffer).toFloat64();
          task[MainListEnum.PayloadType] = PayloadType.NumericBufferParsed;
          return task;
        }
      }
    }
    return task;
  };
};

/**
 * Where:
 *  1 -> Takes the arguments of a MainList
 *  3 -> Takes the return of a MainList
 */
const writeFramePayload = (
  { index, jsonString }: {
    index: PossibleIndexes;
    jsonString?: boolean;
  },
) =>
(
  {
    type,
    uBigInt,
    bigInt,
    int32,
    uInt32,
    float64,
    writeBinary,
    write8Binary,
    writeUtf8,
  }: SignalArguments,
) => {
  const at = index;
  const preProcessed = Boolean(jsonString);

  return (
    task: MainList,
  ) => {
    const args = task[at];

    // Warning: types are not clean after being resolved
    // you must ensure that this `writeFramePayload` is on
    // a different stack
    if (preProcessed === true) {
      switch (task[MainListEnum.PayloadType]) {
        case PayloadType.StringToJson:
          writeUtf8(args as string);
          task[MainListEnum.PayloadType] = PayloadType.Json;
          type[0] = PayloadType.Json;
          return;
        case PayloadType.SerializabledAndReady:
          writeBinary(args as Uint8Array);
          task[MainListEnum.PayloadType] = PayloadType.Serializable;
          type[0] = PayloadType.Serializable;
          return;
        case PayloadType.NumericBufferParsed:
          write8Binary(args as Float64Array);
          task[MainListEnum.PayloadType] = PayloadType.NumericBuffer;
          type[0] = PayloadType.NumericBuffer;
          return;
      }
    }

    switch (typeof args) {
      case "string": {
        writeUtf8(args);
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
            writeUtf8(JSON.stringify(args));
            type[0] = PayloadType.Json;
            return;
          }
          case Map:
          case Set: {
            writeBinary(serialize(args) as Uint8Array);
            type[0] = PayloadType.Serializable;
            return;
          }
          case NumericBuffer: {
            write8Binary((args as NumericBuffer).toFloat64());
            type[0] = PayloadType.NumericBuffer;
            return;
          }
        }

        writeBinary(serialize(args) as Uint8Array);
        type[0] = PayloadType.Serializable;
        return;
      }
    }
  };
};

const readFrameBlocking = (signals: SignalArguments) => {
  return readAnyPayload(signals);
};

const readAnyPayload = (
  {
    readBytesView,
    type,
    uBigInt,
    bigInt,
    uInt32,
    int32,
    float64,
    readUtf8,
    read8BytesFloatView,
  }: SignalArguments,
) =>
() => {
  switch (type[0]) {
    case PayloadType.String:
      return readUtf8();
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
        readUtf8(),
      );
    case PayloadType.Uint8Array:
      return readBytesView();
    case PayloadType.NumericBuffer:
      return NumericBuffer.fromFloat64(read8BytesFloatView());

    case PayloadType.UNREACHABLE:
      throw new Error(
        "something when wrong :( , probably you are not resetting the type correctly",
      );

    // default
    case PayloadType.Serializable:
      return deserialize(readBytesView());
  }
};

const readFramePayload = (
  {
    readBytesView,
    readBytesCopy,
    readUtf8,
    read8BytesFloatCopy,
    type,
    uBigInt,
    bigInt,
    uInt32,
    int32,
    float64,
    specialType,
    frameFlags,
    op,
  }: SignalArguments & {
    specialType: "main" | "thread";
    
  },
) => {
  const changeOwnership = specialType === "main"
    ? () => op[0] = OP.MainReadyToRead
    : () =>
      frameFlags[0] === frameFlagsFlag.Last
        ? (op[0] = OP.WaitingForMore)
        : (op[0] = OP.MainReadyToRead);

  let text: unknown;
  return () => {
    switch (type[0]) {
      case PayloadType.String:
        text = readUtf8();
        changeOwnership();
        return text;
      case PayloadType.BigUint:
        changeOwnership();
        return uBigInt[0];

      case PayloadType.BigInt:
        changeOwnership();
        return bigInt[0];
      case PayloadType.True:
        changeOwnership();
        return true;
      case PayloadType.False:
        changeOwnership();
        return false;
      case PayloadType.Undefined:
        changeOwnership();
        return undefined;
      case PayloadType.NaN:
        changeOwnership();
        return NaN;
      case PayloadType.Infinity:
        changeOwnership();
        return Infinity;
      case PayloadType.NegativeInfinity:
        changeOwnership();
        return -Infinity;
      case PayloadType.Float64:
        changeOwnership();
        return float64[0];
      case PayloadType.Uint32:
        changeOwnership();
        return uInt32[0];
      case PayloadType.Int32:
        changeOwnership();
        return int32[0];
      case PayloadType.Uint64:
        changeOwnership();
        return Number(uBigInt[0]);
      case PayloadType.Int64:
        changeOwnership();
        return Number(bigInt[0]);
      case PayloadType.Null:
        changeOwnership();
        return null;
      case PayloadType.Json:
        text = readUtf8();
        changeOwnership();

        return JSON.parse(
          text as string,
        );

      case PayloadType.Uint8Array:
        text = readBytesCopy();
        changeOwnership();
        return text;
      // default
      case PayloadType.NumericBuffer:
        text = new NumericBuffer(read8BytesFloatCopy());
        changeOwnership();
        return text;

      case PayloadType.Serializable:
        text = deserialize(readBytesView());
        changeOwnership();
        return text;
    }
  };
};

const decodeArgs = (signals: SignalArguments) => {
  return readAnyPayload(signals);
};

const readPayloadError = ({ readBytesView }: SignalArguments) => () =>
  deserialize(readBytesView());

export {
  decodeArgs,
  fromReturnToMainError,
  preencodeJsonString,
  readAnyPayload,
  readFrameBlocking,
  readFramePayload,
  readPayloadError,
  writeFramePayload,
};
