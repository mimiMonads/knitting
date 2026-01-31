export type SignalArguments = ReturnType<typeof createSharedMemoryTransport>;
export type MainSignal = ReturnType<typeof mainSignal>;
import { isMainThread } from "node:worker_threads";
import { beat, signalDebuggerV2 } from "../../common/others.ts";
import { createSharedArrayBuffer } from "../../common/runtime.ts";
import { type DebugOptions } from "../../types.ts";

const page = 1024 * 4;
const CACHE_LINE_BYTES = 64;

// Keep hot signals on separate cache lines to avoid false sharing.
const SIGNAL_OFFSETS = {
  op: 0,
  rxStatus: CACHE_LINE_BYTES,
  txStatus: CACHE_LINE_BYTES * 2,
} as const;

const a_store = Atomics.store;

export type Sab = {
  size?: number;
  sharedSab?: SharedArrayBuffer;
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
  const toGrow = sabObject?.size ?? page;
  const sab = sabObject?.sharedSab
    ? sabObject.sharedSab
    : createSharedArrayBuffer(
      toGrow + (toGrow % page),
      page * page,
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
      op: new Int32Array(sab, SIGNAL_OFFSETS.op, 1),
    })
    : new Int32Array(sab, SIGNAL_OFFSETS.op, 1);

  if (isMainThread) {
    a_store(new Int32Array(sab, SIGNAL_OFFSETS.op, 1), 0, 0);
  }

  const rxStatus = new Int32Array(sab, SIGNAL_OFFSETS.rxStatus, 1);

  a_store(rxStatus, 0, 1);
  return {
    sab,
    op,
    startAt,
    isReflected,
    // When we debug we wrap op in a proxy thus it stop being an array,
    // There are some JS utils that would complain about it (Atomics)
    opView: new Int32Array(sab, SIGNAL_OFFSETS.op, 1),
    rxStatus,
    txStatus: new Int32Array(sab, SIGNAL_OFFSETS.txStatus, 1),
  };
};

export const mainSignal = (
  { op, opView, startAt, rxStatus, txStatus }:
    SignalArguments,
) => {
  return ({
    op,
    opView,
    startAt,
    rxStatus,
    txStatus,
  });
};
