export type SignalArguments = ReturnType<typeof createSharedMemoryTransport>;
export type MainSignal = ReturnType<typeof mainSignal>;
export type WorkerSignal = ReturnType<typeof workerSignal>;
import { isMainThread } from "node:worker_threads";
import { beat, signalDebuggerV2 } from "../../common/others.ts";
import { type DebugOptions } from "../../api.ts";
import { Buffer as NodeBuffer } from "node:buffer";

enum SignalEnumOptions {
  header = 32,
  maxByteLength = 64 * 1024 * 1024,
  defaultSize = 1024 * 64,
  safePadding = 512,
}

export enum OP {
  Created = 0,
  WorkerWaiting = 1,
  AllTasksDone = 2,
  WaitingForMore = 3,
  HighPriorityResolve = 4,
  WakeUp = 5,
  ErrorThrown = 6,
  NAN = 7,
  MainReadyToRead = 8,
  FastResolve = 9,
  MainSend = 10,
  MainStop = 11,
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

const allocatePayloadBuffer = ({ sab, payloadLen }: {
  sab: SharedArrayBuffer;
  payloadLen: Int32Array;
}) => {
  let currentSize = sab.byteLength - SignalEnumOptions.header;
  let uInt8 = new Uint8Array(sab, SignalEnumOptions.header);
  let buff = NodeBuffer.from(sab, SignalEnumOptions.header);

  const readUtf8 = () => buff.toString("utf8", 0, payloadLen[0]);
  const writeBinary = (buffer: Uint8Array) => {
    if (
      currentSize < buffer.length
    ) {
      const required = buffer.length + SignalEnumOptions.header +
        SignalEnumOptions.safePadding;
      sab.grow(required);
      currentSize = sab.byteLength - SignalEnumOptions.header;
      uInt8 = new Uint8Array(sab, SignalEnumOptions.header);
      buff = NodeBuffer.from(sab, SignalEnumOptions.header);
    }
    uInt8.set(buffer, 0);
    payloadLen[0] = buffer.length;
  };
  return {
    readUtf8,
    writeBinary,
    readBytesCopy: () => uInt8.slice(0, payloadLen[0]),
    readBytesView: () => uInt8.subarray(0, payloadLen[0]),
    writeUtf8: (str: string) => {
      const { written, read } = textEncode.encodeInto(str, uInt8);
      payloadLen[0] = written;

      if (read < str.length) {
        return writeBinary(textEncode.encode(str));
      }
    },
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
  const sab = sabObject?.sharedSab
    ? sabObject.sharedSab
    : new SharedArrayBuffer(sabObject?.size ?? SignalEnumOptions.defaultSize, {
      maxByteLength: SignalEnumOptions.maxByteLength,
    });

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
  const { writeBinary, readBytesCopy, readBytesView, writeUtf8, readUtf8 } =
    allocatePayloadBuffer({
      sab,
      payloadLen,
    });

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
    workerop: new Int32Array(sab, 28, 1),
    // Access to the current length of the payload
    payloadLen,
    // Modifying shared memory
    writeBinary,
    writeUtf8,
    readBytesCopy,
    readBytesView,
    readUtf8,
    // One byte var
    bigInt: new BigInt64Array(sab, SignalEnumOptions.header, 1),
    uBigInt: new BigUint64Array(sab, SignalEnumOptions.header, 1),
    uInt32: new Uint32Array(sab, SignalEnumOptions.header, 1),
    int32: new Int32Array(sab, SignalEnumOptions.header, 1),
    float64: new Float64Array(sab, SignalEnumOptions.header, 1),
  };
};

export const mainSignal = (
  { op, id, rpcId, frameFlags, opView, slotIndex, startAt }: SignalArguments,
) => ({
  op,
  opView,
  rpcId,
  id,
  slotIndex,
  frameFlags,
  startAt,
});

export const workerSignal = (
  { op, id, rpcId, frameFlags, slotIndex, isReflected }: SignalArguments,
) => ({
  op,
  id,
  slotIndex,
  rpcId,
  frameFlags,
  isReflected,
});
