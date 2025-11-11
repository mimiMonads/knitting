export type SignalArguments = ReturnType<typeof createSharedMemoryTransport>;
export type MainSignal = ReturnType<typeof mainSignal>;
export type WorkerSignal = ReturnType<typeof workerSignal>;
import { isMainThread } from "node:worker_threads";
import { beat, signalDebuggerV2 } from "../../common/others.ts";
import { type DebugOptions } from "../../types.ts";
import { Buffer as NodeBuffer } from "node:buffer";

const page = 1024 * 4;
enum SignalEnumOptions {
  header = 64,
  maxByteLength = page * page,
  defaultSize = page,
  safePadding = page,
}

export enum HostOP {
  Created = 0,
  HighPriorityResolve = 4,
  WakeUp = 5,
  NAN = 7,
  MainReadyToRead = 8,
  MainSend = 10,
  MainStop = 11,
}

export enum WorkerOP {
  WorkerWaiting = 1,
  AllTasksDone = 2,
  WaitingForMore = 3,
  ErrorThrown = 6,
  FastResolve = 9,
}

export enum OP {
  Created = HostOP.Created,
  WorkerWaiting = WorkerOP.WorkerWaiting,
  AllTasksDone = WorkerOP.AllTasksDone,
  WaitingForMore = WorkerOP.WaitingForMore,
  HighPriorityResolve = HostOP.HighPriorityResolve,
  WakeUp = HostOP.WakeUp,
  ErrorThrown = WorkerOP.ErrorThrown,
  NAN = HostOP.NAN,
  MainReadyToRead = HostOP.MainReadyToRead,
  FastResolve = WorkerOP.FastResolve,
  MainSend = HostOP.MainSend,
  MainStop = HostOP.MainStop,
}

export const OP_TAG: Record<OP, string> = {
  [OP.Created]: "START ",
  [OP.WorkerWaiting]: "WWAIT ",
  [OP.AllTasksDone]: "DONE  ",
  [OP.WaitingForMore]: "WMORE ",
  [OP.HighPriorityResolve]: "HIPRIO",
  [OP.WakeUp]: "WAKEUP",
  [OP.ErrorThrown]: "ERROR ",
  [OP.NAN]: "NAN   ",
  [OP.MainReadyToRead]: "MREAD ",
  [OP.FastResolve]: "FRESOL",
  [OP.MainSend]: "MSEND ",
  [OP.MainStop]: "MSTOP ",
};

// ───────────────────────────────────────────────
// Queue State Flags
// ───────────────────────────────────────────────
export enum frameFlagsFlag {
  NotLast = 0,
  Last = 1,
}

export type Sab = {
  size?: number;
  sharedSab?: SharedArrayBuffer;
};
const textEncode = new TextEncoder();

const alignUpto64 = (n: number) => (n + (64 - 1)) & ~(64 - 1);

export const allocatePayloadBuffer = ({
  sab,
  payloadLen, // always store BYTES!! here
}: {
  sab: SharedArrayBuffer;
  payloadLen: Int32Array;
}) => {
  let u8 = new Uint8Array(sab, SignalEnumOptions.header);
  let buf = NodeBuffer.from(sab, SignalEnumOptions.header);
  let f64 = new Float64Array(sab, SignalEnumOptions.header);

  const capacityBytes = () => sab.byteLength - SignalEnumOptions.header;

  const ensureCapacity = (neededBytes: number) => {
    if (capacityBytes() >= neededBytes) return;

    sab.grow(
      alignUpto64(
        SignalEnumOptions.header + neededBytes + SignalEnumOptions.safePadding,
      ),
    );

    u8 = new Uint8Array(
      sab,
      SignalEnumOptions.header,
      sab.byteLength - SignalEnumOptions.header,
    );
    buf = NodeBuffer.from(
      sab,
      SignalEnumOptions.header,
      sab.byteLength - SignalEnumOptions.header,
    );
    f64 = new Float64Array(
      sab,
      SignalEnumOptions.header,
      (sab.byteLength - SignalEnumOptions.header) >>> 3,
    );
  };

  const readUtf8 = () => buf.toString("utf8", 0, payloadLen[0]);

  const writeBinary = (src: Uint8Array) => {
    ensureCapacity(src.byteLength);
    u8.set(src, 0);
    payloadLen[0] = src.byteLength; // BYTES
  };

  const write8Binary = (src: Float64Array) => {
    const bytes = src.byteLength;
    ensureCapacity(bytes);
    f64.set(src, 0);
    payloadLen[0] = bytes; // BYTES
  };

  const readBytesCopy = () => u8.slice(0, payloadLen[0]);
  const readBytesView = () => u8.subarray(0, payloadLen[0]);

  const read8BytesFloatCopy = () => f64.slice(0, payloadLen[0] >>> 3);
  const read8BytesFloatView = () => f64.subarray(0, payloadLen[0] >>> 3);

  const writeUtf8 = (str: string) => {
    const { written, read } = textEncode.encodeInto(str, u8);
    payloadLen[0] = written;
    if (read < str.length) {
      return writeBinary(textEncode.encode(str));
    }
  };

  return {
    readUtf8,
    writeBinary,
    write8Binary,
    readBytesCopy,
    readBytesView,
    read8BytesFloatCopy,
    read8BytesFloatView,
    writeUtf8,
  };
};

type SignalForWorker = {
  sabObject?: Sab;
  isMain: boolean;
  thread: number;
  debug?: DebugOptions;
  startTime?: number;
};
export const createSharedMemoryTransport = (
  { sabObject, isMain, thread, debug, startTime }: SignalForWorker,
) => {
  const toGrow = sabObject?.size ?? SignalEnumOptions.defaultSize;
  const sab = sabObject?.sharedSab
    ? sabObject.sharedSab
    : new SharedArrayBuffer(
      toGrow + (toGrow % page),
      {
        maxByteLength: SignalEnumOptions.maxByteLength,
      },
    );

  const startAt = beat();

  const isReflected = typeof debug !== "undefined" &&
    // This part just say `match the function on the thread and main parts and the debug parts`
    ((debug?.logMain === isMain && isMain === true) ||
      //@ts-ignore
      (debug?.logThreads === true && isMain === false));

  const op = isReflected
    ? signalDebuggerV2({
      thread,
      isMain,
      startAt: startTime ?? startAt,
      op: new Int32Array(sab, 0, 1),
    })
    : new Int32Array(sab, 0, 1);

  // Stopping Threads
  if (isMainThread) {
    op[0] = OP.MainStop;
  }

  const payloadLen = new Int32Array(sab, 8, 1);
  const {
    writeBinary,
    readBytesCopy,
    readBytesView,
    writeUtf8,
    readUtf8,
    write8Binary,
    read8BytesFloatCopy,
    read8BytesFloatView,
  } = allocatePayloadBuffer({
    sab,
    payloadLen,
  });

  const rxStatus = new Int32Array(sab, 28, 1);

  rxStatus[0] = 1;
  return {
    sab,
    op,
    startAt,
    isReflected,
    // When we debug we wrap op in a proxy thus it stop being an array,
    // There are some JS utils that would complain about it (Atomics)
    opView: new Int32Array(sab, 0, 1),
    // Headers
    id: new Int32Array(sab, 4, 1),
    rpcId: new Int32Array(sab, 12, 1),
    frameFlags: new Int32Array(sab, 16, 1),
    type: new Int32Array(sab, 20, 1),
    slotIndex: new Int32Array(sab, 24, 1),
    rxStatus,
    txStatus: new Int32Array(sab, 32, 1),
    // Access to the current length of the payload
    payloadLen,
    // Modifying shared memory
    writeBinary,
    write8Binary,
    writeUtf8,
    readBytesCopy,
    readBytesView,
    readUtf8,
    read8BytesFloatCopy,
    read8BytesFloatView,
    // One byte var
    bigInt: new BigInt64Array(sab, SignalEnumOptions.header, 1),
    uBigInt: new BigUint64Array(sab, SignalEnumOptions.header, 1),
    uInt32: new Uint32Array(sab, SignalEnumOptions.header, 1),
    int32: new Int32Array(sab, SignalEnumOptions.header, 1),
    float64: new Float64Array(sab, SignalEnumOptions.header, 1),
  };
};

export const mainSignal = (
  { op, id, rpcId, frameFlags, opView, slotIndex, startAt, rxStatus, txStatus }:
    SignalArguments,
) => {
  return ({
    op,
    opView,
    rpcId,
    id,
    slotIndex,
    frameFlags,
    startAt,
    rxStatus,
    txStatus,
  });
};

export const workerSignal = (
  { op, id, rpcId, frameFlags, slotIndex, isReflected, rxStatus, txStatus }:
    SignalArguments,
) => ({
  op,
  id,
  slotIndex,
  rpcId,
  frameFlags,
  isReflected,
  rxStatus,
});
