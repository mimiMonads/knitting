import type { Serializable } from "./taskApi.ts";
import {
  QueueStateFlag,
  type SignalArguments,
  SignalStatus,
} from "./signals.ts";
import type { MainList } from "./mainQueueManager.ts";
import { MainListEnum } from "./mainQueueManager.ts";

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
}

const fromReturnToMainError = ({
  type,
  setBuffer,
}: SignalArguments) => {
  const serilizedError = serialize(
    new Error("The thrown object is not serializable"),
  );

  return (task: MainList) => {
    let error: Serializable;

    try {
      error = serialize(task[MainListEnum.WorkerResponse]);
    } catch (_) {
      error = serilizedError;
    }

    setBuffer(error as Uint8Array);

    type[0] = PayloadType.Serializable;
  };
};

type PossibleIndexes = MainListEnum.RawArguments | MainListEnum.WorkerResponse;

const encode = new TextEncoder();
const simplifyJson = (
  { index }: {
    index: PossibleIndexes;
  },
) => {
  const at = index;

  return (task: MainList) => {
    const args = task[at];

    if (typeof args === "object") {
      if (args === null) return;

      task[at] = JSON.stringify(args);
      task[MainListEnum.PlayloadType] = PayloadType.StringToJson;
    }
  };
};

/**
 * Where:
 *  1 -> Takes the arguments of a MainList
 *  3 -> Takes the return of a MainList
 */
const writeToShareMemory = (
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
    setBuffer,
    setString,
  }: SignalArguments,
) => {
  const at = index;
  const preProcessed = Boolean(jsonString);

  return (
    task: MainList,
  ) => {
    const args = task[at];

    // Warning: types are not clean after being resolved
    // you must ensure that this `writeToShareMemory` is on
    // a different stack
    if (preProcessed === true) {
      if (task[MainListEnum.PlayloadType] === PayloadType.StringToJson) {
        setString(args as string);
        task[MainListEnum.PlayloadType] = PayloadType.Json;
        return;
      }
    }

    switch (typeof args) {
      case "string": {
        setString(args);
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
            setString(JSON.stringify(args));
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
};

const readFromWorker = (signals: SignalArguments) => {
  return readPayloadWorkerAny(signals);
};

const readPayloadWorkerAny = (
  {
    subarray,
    type,
    uBigInt,
    bigInt,
    uInt32,
    int32,
    float64,
    buffToString,
  }: SignalArguments,
) =>
() => {
  switch (type[0]) {
    case PayloadType.String:
      return buffToString();
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
        buffToString(),
      );
    case PayloadType.Uint8Array:
      return subarray();
    case PayloadType.UNREACHABLE:
      throw new Error(
        "something when wrong :( , probably you are not reseting the type correctly",
      );

    // default
    case PayloadType.Serializable:
      return deserialize(subarray());
  }
};

const readPayloadWorkerBulk = (
  {
    subarray,
    slice,
    buffToString,
    type,
    uBigInt,
    bigInt,
    uInt32,
    int32,
    float64,
    specialType,
    queueState,
    status,
  }: SignalArguments & {
    specialType: "main" | "thread";
  },
) => {
  const changeOwnership = specialType === "main"
    ? () => status[0] = SignalStatus.MainReadyToRead
    : () =>
      queueState[0] === QueueStateFlag.Last
        ? (status[0] = SignalStatus.WaitingForMore)
        : (status[0] = SignalStatus.MainReadyToRead);
  let text: unknown;
  return () => {
    switch (type[0]) {
      case PayloadType.String:
        text = buffToString();
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
        text = buffToString();

        changeOwnership();

        return JSON.parse(
          text as string,
        );

      case PayloadType.Uint8Array:
        text = slice();
        changeOwnership();
        return text;
      // default
      case PayloadType.Serializable:
        text = deserialize(subarray());
        changeOwnership();
        return text;
    }
  };
};

const fromPlayloadToArguments = (signals: SignalArguments) => {
  return readPayloadWorkerAny(signals);
};

const readPayloadError = ({ subarray }: SignalArguments) => () =>
  deserialize(subarray());

export {
  fromPlayloadToArguments,
  fromReturnToMainError,
  readFromWorker,
  readPayloadError,
  readPayloadWorkerAny,
  readPayloadWorkerBulk,
  simplifyJson,
  writeToShareMemory,
};
