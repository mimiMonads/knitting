/** */

import { type External } from "./taskApi.ts";
import { type SignalArguments } from "./signals.ts";
import type { MainList, QueueListWorker } from "./mainQueueManager.ts";
import { deserialize, serialize } from "node:v8";
import { Buffer } from "node:buffer";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toWorkerUint8 =
  ({ id, payload, payloadLength }: SignalArguments) => (task: MainList) => {
    payload.set(task[1]);
    payloadLength[0] = task[1].length;
    id[0] = task[0];
  };

const toWorkerSerializable =
  ({ id, buffer, payloadLength }: SignalArguments) => (task: MainList) => {
    const encoded = serialize(task[1]);

    //@ts-ignore
    buffer.set(encoded);
    //@ts-ignore
    payloadLength[0] = encoded.length;

    id[0] = task[0];
  };

const toWorkerString =
  ({ id, payload, payloadLength }: SignalArguments) => (task: MainList) => {
    //@ts-ignore
    const encode = textEncoder.encode(task[1]);
    payload.set(encode);
    payloadLength[0] = encode.length;
    id[0] = task[0];
  };

const toWorkerVoid =
  ({ id, payloadLength }: SignalArguments) => (task: MainList) => {
    payloadLength[0] = 0;
    id[0] = task[0];
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
      return toWorkerSerializable(signals);
  }
};

const readUint8FromWorker =
  ({ payload, payloadLength }: SignalArguments) => () =>
    payload.slice(0, payloadLength[0].valueOf());

const readStringFromWorker =
  ({ payload, payloadLength }: SignalArguments) => () =>
    textDecoder.decode(payload.slice(0, payloadLength[0].valueOf()));

const readVoidFromWorker = ({}: SignalArguments) => () => undefined;

const readSerializableFromWorker =
  ({ buffer, payloadLength }: SignalArguments) => () => {
    const data = buffer.subarray(0, payloadLength[0].valueOf());
    return deserialize(data);
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
      return readSerializableFromWorker(signals);
  }
};

///  WORKER ///

const readPayloadWorkerUint8 =
  ({ payload, payloadLength }: SignalArguments) => () =>
    payload.slice(0, payloadLength[0].valueOf());

const readPayloadWorkerString =
  ({ payload, payloadLength }: SignalArguments) => () =>
    textDecoder.decode(payload.subarray(0, payloadLength[0].valueOf()));

const readPayloadWorkerVoid = ({}: SignalArguments) => () => undefined;

const readPayloadWorkerSerializable =
  ({ buffer, payloadLength }: SignalArguments) => () => {
    return deserialize(buffer.subarray(0, payloadLength[0].valueOf()));
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
        return readPayloadWorkerSerializable(signals);
    }
  };

const writePayloadUnint8 =
  ({ id, payload, payloadLength }: SignalArguments) =>
  (task: QueueListWorker) => {
    payload.set(task[4], 0);
    payloadLength[0] = task[4].length;
    id[0] = task[1];
  };

const writePayloadString =
  ({ id, payload, payloadLength }: SignalArguments) =>
  (task: QueueListWorker) => {
    //@ts-ignore
    const encode = textEncoder.encode(task[4]);
    payload.set(encode, 0);
    payloadLength[0] = encode.length;
    id[0] = task[1];
  };

const writePayloadVoid =
  ({ id }: SignalArguments) => (task: QueueListWorker) => {
    // No payload needed
    id[0] = task[1];
  };

const writePayloadSerializable =
  ({ id, buffer, payloadLength }: SignalArguments) =>
  (
    task: QueueListWorker,
  ) => {
    const encoded = serialize(task[4]);
    //@ts-ignore
    buffer.set(encoded);
    //@ts-ignore
    payloadLength[0] = encoded.length;
    id[0] = task[1];
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
      return writePayloadSerializable(signals);
  }
};

export {
  fromPlayloadToArguments,
  fromreturnToMain,
  readFromWorker,
  sendToWorker,
};
