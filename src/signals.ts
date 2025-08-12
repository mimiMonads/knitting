export type SignalArguments = ReturnType<typeof signalsForWorker>;
export type MainSignal = ReturnType<typeof mainSignal>;
export type WorkerSignal = ReturnType<typeof workerSignal>;
import { isMainThread } from "node:worker_threads";
import { signalDebuggerV2 } from "./utils.ts";
import { type DebugOptions } from "./taskApi.ts";
import { Buffer as NodeBuffer } from "node:buffer";

enum SignalEnumOptions {
  header = 32,
  maxByteLength = 64 * 1024 * 1024,
  defaultSize = 1024 * 64,
  safePadding = 512,
}

export enum SignalStatus {
  WorkerWaiting = 1,
  AllTasksDone = 2,
  WaitingForMore = 3,
  HighPriorityResolve = 4,
  DoNothing = 5,
  ErrorThrown = 6,
  Promify = 7,
  MainReadyToRead = 8,
  FastResolve = 9,
  MainSend = 10,
  MainSemiStop = 11,
  MainStop = 12,
}

// ───────────────────────────────────────────────
// Queue State Flags
// ───────────────────────────────────────────────
export enum QueueStateFlag {
  NotLast = 0,
  Last = 1,
}

const IS_DENO = typeof Deno == "object" && Deno !== null;

export type Sab = {
  size?: number;
  sharedSab?: SharedArrayBuffer;
};
const textEncode = new TextEncoder();

const allocBuffer = ({ sab, payloadLength }: {
  sab: SharedArrayBuffer;
  payloadLength: Int32Array;
}) => {
  let currentSize = sab.byteLength + SignalEnumOptions.header;
  let uInt8 = new Uint8Array(sab, SignalEnumOptions.header);
  let buff = NodeBuffer.from(sab, SignalEnumOptions.header);
  const textDecoder = new TextDecoder();

  const buffToString = IS_DENO
    ? () => textDecoder.decode(uInt8.subarray(0, payloadLength[0]))
    : () => buff.toString("utf8", 0, payloadLength[0]);

  return {
    buffToString,
    slice: () => uInt8.slice(0, payloadLength[0]),
    subarray: () => uInt8.subarray(0, payloadLength[0]),
    setString: (str: string) => {
      if (
        currentSize <
          str.length + SignalEnumOptions.header + SignalEnumOptions.safePadding
      ) {
        const required = str.length + SignalEnumOptions.header +
          SignalEnumOptions.safePadding;
        sab.grow(required);
        currentSize = sab.byteLength + SignalEnumOptions.header;
        uInt8 = new Uint8Array(sab, SignalEnumOptions.header);
        buff = NodeBuffer.from(sab, SignalEnumOptions.header);
      }

      textEncode.encodeInto(str, uInt8);
      payloadLength[0] = str.length;
    },
    setBuffer: (buffer: Uint8Array) => {
      if (
        currentSize <
          buffer.length + SignalEnumOptions.header +
            SignalEnumOptions.safePadding
      ) {
        const required = buffer.length + SignalEnumOptions.header +
          SignalEnumOptions.safePadding;
        sab.grow(required);
        currentSize = sab.byteLength + SignalEnumOptions.header;
        uInt8 = new Uint8Array(sab, SignalEnumOptions.header);
        buff = NodeBuffer.from(sab, SignalEnumOptions.header);
      }
      uInt8.set(buffer, 0);
      payloadLength[0] = buffer.length;
    },
  };
};

type SignalForWorker = {
  sabObject?: Sab;
  isMain: boolean;
  thread: number;
  debug?: DebugOptions;
};
export const signalsForWorker = (
  { sabObject, isMain, thread, debug }: SignalForWorker,
) => {
  const sab = sabObject?.sharedSab
    ? sabObject.sharedSab
    : new SharedArrayBuffer(sabObject?.size ?? SignalEnumOptions.defaultSize, {
      maxByteLength: SignalEnumOptions.maxByteLength,
    });

  const status = typeof debug !== undefined &&
      // This part just say `match the function on the thread and main parts and the debug parts`
      ((debug?.logMain === isMain && isMain === true) ||
        (debug?.logThreads === true && isMain === false))
    ? signalDebuggerV2({
      thread,
      isMain,
      status: new Int32Array(sab, 0, 1),
    })
    : new Int32Array(sab, 0, 1);

  // Stopping Threads
  if (isMainThread) {
    status[0] = SignalStatus.MainStop;
  }

  const payloadLength = new Int32Array(sab, 8, 1);
  const { setBuffer, slice, subarray, setString, buffToString } = allocBuffer({
    sab,
    payloadLength,
  });

  return {
    sab,
    status,
    // When we debug we wrap status in a proxy thus it stop being an array,
    // There are some JS utils that would complain about it (Atomics)
    rawStatus: new Int32Array(sab, 0, 1),
    // Headers
    id: new Int32Array(sab, 4, 1),
    functionToUse: new Int32Array(sab, 12, 1),
    queueState: new Int32Array(sab, 16, 1),
    type: new Int32Array(sab, 20, 1),
    slotIndex: new Int32Array(sab, 24, 1),
    // Access to the current length of the payload
    payloadLength,
    // Modifying shared memory
    setBuffer,
    setString,
    slice,
    subarray,
    buffToString,
    // One byte var
    bigInt: new BigInt64Array(sab, SignalEnumOptions.header, 1),
    uBigInt: new BigUint64Array(sab, SignalEnumOptions.header, 1),
    uInt32: new Uint32Array(sab, SignalEnumOptions.header, 1),
    int32: new Int32Array(sab, SignalEnumOptions.header, 1),
    float64: new Float64Array(sab, SignalEnumOptions.header, 1),
  };
};

export const mainSignal = (
  { status, id, functionToUse, queueState, rawStatus, slotIndex }:
    SignalArguments,
) => ({
  status,
  rawStatus,
  functionToUse,
  id,
  slotIndex,
  queueState,
});

export const workerSignal = (
  { status, id, functionToUse, queueState, slotIndex }: SignalArguments,
) => ({
  status,
  id,
  slotIndex,
  functionToUse,
  queueState,
});
