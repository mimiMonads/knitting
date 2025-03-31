/** */

import { type External } from "./taskApi.ts";
import { type SignalArguments } from "./signals.ts";
import type { MainList, QueueListWorker } from "./mainQueueManager.ts";

const toWorkerUint8 =
  ({ id, payload, payloadLength }: SignalArguments) => (task: MainList) => {
    payload.set(task[1]);
    payloadLength[0] = task[1].length;
    id[0] = task[0];
  };

const toWorkerVoid =
  ({ id, payloadLength }: SignalArguments) => (task: MainList) => {
    payloadLength[0] = 0;
    id[0] = task[0];
  };

const sendToWorker = ({
  signals,
  type,
}: {
  signals: SignalArguments;
  type: External;
}) => {
  switch (type) {
    case "uint8":
      return toWorkerUint8(signals);

    // We are using the same as void because it is posible to set a string in a UInt8
    case "string":
      return toWorkerUint8(signals);

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
    payload.subarray(0, payloadLength[0].valueOf()).toString();

const readPayloadWorkerVoid = ({}: SignalArguments) => () => undefined;

const fromPlayloadToArguments = ({
  signals,
  type,
}: {
  signals: SignalArguments;
  type: External;
}) => {
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
