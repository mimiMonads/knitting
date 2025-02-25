export type SignalArguments = ReturnType<typeof signalsForWorker>;
export type MainSignal = ReturnType<typeof mainSignal>;
export type WorkerSignal = ReturnType<typeof workerSignal>;
import { Buffer } from "node:buffer";

type StatusSignalForVoid = 224 | 192;
export type StatusSignal = StatusSignalForVoid;

export type Sab = {
  size?: number;
  sharedSab?: SharedArrayBuffer;
};

export const signalsForWorker = (args?: Sab) => {
  const sab = args?.sharedSab
    ? args.sharedSab
    : new SharedArrayBuffer(args?.size ?? 4096);

  return {
    sab,
    status: new Int32Array(sab, 0, 1),
    id: new Int32Array(sab, 4, 1),
    payloadLenght: new Int32Array(sab, 8, 1),
    funtionToUse: new Int32Array(sab, 12, 1),
    queueState: new Int8Array(sab, 16, 4),
    payload: new Uint8Array(sab, 20),
    buffer: Buffer.from(sab, 20),
  };
};

export const mainSignal = (
  { status, id, funtionToUse, queueState }: SignalArguments,
) => {
  return ({
    // Status
    updateLastSignal: () => (status[0]),
    send: (): 192 => (status[0] = 192),
    setFunctionSignal: (signal: number) => (funtionToUse[0] = signal),
    setSignal: (signal: StatusSignal) => (status[0] = signal),
    hasNoMoreMessages: (): 255 => (status[0] = 255),
    readyToRead: (): 127 => (status[0] = 127),
    // ID
    getCurrentID: () => id[0],
    // Queue state
    isLastElementToSend: (state: boolean) =>
      state === true ? queueState[0] = 1 : queueState[0] = 0,
  });
};

export const workerSignal = (
  { status, id, funtionToUse, queueState }: SignalArguments,
) => ({
  // Status
  currentSignal: () => status[0],
  messageReady: (): 0 => (status[0] = 0),
  markMessageAsRead: (): 1 => (status[0] = 1),
  signalAllTasksDone: (): 2 => (status[0] = 2),
  waitingForMore: (): 3 => (status[0] = 3),
  readyToRead: (): 127 => (status[0] = 127),
  // Queue State
  logWorkStatus: () => queueState[0],
  readyToWork: () => queueState[0] === 1 ? status[0] = 3 : status[0] = 127,
  // Others
  getCurrentID: () => id[0],
  functionToUse: () => funtionToUse[0],
});
