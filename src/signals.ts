export type SignalArguments = ReturnType<typeof signalsForWorker>;
export type MainSignal = ReturnType<typeof mainSignal>;
export type WorkerSignal = ReturnType<typeof workerSignal>;

type StatusSignalForVoid = 192;
export type StatusSignal = StatusSignalForVoid;

export type Sab = {
  size?: number;
  sharedSab?: SharedArrayBuffer;
};

export const signalsForWorker = (args?: Sab) => {
  const sab = args?.sharedSab
    ? args.sharedSab
    : new SharedArrayBuffer(args?.size ?? 65536);

  const status = new Int32Array(sab, 0, 1);
  status[0] = 0;

  return {
    sab,
    status,
    id: new Int32Array(sab, 4, 1),
    payloadLength: new Int32Array(sab, 8, 1),
    functionToUse: new Int32Array(sab, 12, 1),
    queueState: new Int8Array(sab, 16, 4),
    type: new Int32Array(sab, 20, 1),
    payload: new Uint8Array(sab, 24, sab.byteLength - 24),
    buffer: new Uint8Array(sab, 24, sab.byteLength - 24),

    // One byte var
    bigInt: new BigInt64Array(sab, 24, 1),
    uBigInt: new BigUint64Array(sab, 24, 1),
    uInt32: new Uint32Array(sab, 24, 1),
    int32: new Int32Array(sab, 24, 1),
    float64: new Float64Array(sab, 24, 1),
  };
};

export const mainSignal = (
  { status, id, functionToUse, queueState }: SignalArguments,
) => {
  return ({
    status,
    // Status
    currentSignal: () => (status[0]),
    send: (): 192 => (status[0] = 192),
    setFunctionSignal: (signal: number) => (functionToUse[0] = signal),
    hasNoMoreMessages: (): 255 => (status[0] = 255),
    readyToRead: (): 128 => (status[0] = 128),
    // ID
    getCurrentID: () => id[0],
    // Queue state
    isLastElementToSend: (state: boolean) =>
      state === true ? queueState[0] = 1 : queueState[0] = 0,
  });
};

export const workerSignal = (
  { status, id, functionToUse, queueState }: SignalArguments,
) => ({
  status,
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
  functionToUse: () => functionToUse[0],
});
