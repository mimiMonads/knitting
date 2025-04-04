/** */

import { type External } from "./taskApi.ts";
import { type SignalArguments } from "./signals.ts";
import type { MainList, QueueListWorker } from "./mainQueueManager.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toWorkerUint8 =
  ({ id, payload, payloadLength }: SignalArguments) => (task: MainList) => {
    payload.set(task[1]);
    payloadLength[0] = task[1].length;
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

const sendToWorker = (
  signals: SignalArguments,
) =>
(type: External) => {
  switch (type) {
    case "uint8":
      return toWorkerUint8(signals);

    case "string":
      return toWorkerString(signals);

    case "void":
      return toWorkerVoid(signals);

    default:
      throw "Unreachable";
      break;
  }
};

const readPayloadWorkerUint8 =
  ({ payload, payloadLength }: SignalArguments) => () =>
    payload.slice(0, payloadLength[0].valueOf());

const readPayloadWorkerString =
  ({ payload, payloadLength }: SignalArguments) => () =>
    textDecoder.decode(payload.subarray(0, payloadLength[0].valueOf()));

const readPayloadWorkerVoid = ({}: SignalArguments) => () => undefined;

const fromPlayloadToArguments = (
  signals: SignalArguments,
) =>
(type: External) => {
  switch (type) {
    case "uint8":
      return readPayloadWorkerUint8(signals);
    case "string":
      return readPayloadWorkerString(signals);
    case "void":
      return readPayloadWorkerVoid(signals);
  }
};

//   // Write a Uint8Array message with task metadata.
// export const writePayload =
// ({ id, payload, payloadLength }: SignalArguments) => (task: QueueListWorker) => {
//   payload.set(task[4], 0);
//   payloadLength[0] = task[4].length;
//   id[0] = task[1];
// };

export { fromPlayloadToArguments, sendToWorker };
