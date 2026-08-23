export type SignalArguments = ReturnType<typeof createSharedMemoryTransport>;
import { createSharedArrayBuffer } from "../../common/runtime.ts";
import {
  toSharedBufferRegion,
  type SharedBufferSource,
} from "../../common/shared-buffer-region.ts";

const page = 1024 * 4;
const CACHE_LINE_BYTES = 64;

// Keep hot signals on separate cache lines to avoid false sharing.
const SIGNAL_OFFSETS = {
  op: 0,
  rxStatus: CACHE_LINE_BYTES,
  txStatus: CACHE_LINE_BYTES * 2,
  stop: CACHE_LINE_BYTES * 3,
} as const;
export const TRANSPORT_SIGNAL_BYTES = CACHE_LINE_BYTES * 4;

/** States of the worker-stop word. */
export const WORKER_STOP = {
  running: 0,
  requested: 1,
  /** The worker has left its dispatch loop. */
  acknowledged: 2,
} as const;

const a_store = Atomics.store;

export type Sab = {
  size?: number;
  sharedSab?: SharedBufferSource;
};

type SignalForWorker = {
  sabObject?: Sab;
  isMain: boolean;
  thread: number;
  startTime?: number;
};

export const createSharedMemoryTransport = (
  { sabObject, isMain, startTime }: SignalForWorker,
) => {
  const toGrow = sabObject?.size ?? page;
  const roundedSize = toGrow + ((page - (toGrow % page)) % page);
  const signalRegion = toSharedBufferRegion(
    sabObject?.sharedSab
      ? sabObject.sharedSab
    : createSharedArrayBuffer(
      roundedSize,
      page * page,
    ),
  );
  const sab = signalRegion.sab;
  const baseByteOffset = signalRegion.byteOffset;

  const startAt = startTime ?? performance.now();
  const opView = new Int32Array(sab, baseByteOffset + SIGNAL_OFFSETS.op, 1);
  if (isMain) a_store(opView, 0, 0);

  const rxStatus = new Int32Array(
    sab,
    baseByteOffset + SIGNAL_OFFSETS.rxStatus,
    1,
  );

  a_store(rxStatus, 0, 1);

  const stopView = new Int32Array(
    sab,
    baseByteOffset + SIGNAL_OFFSETS.stop,
    1,
  );
  if (isMain) a_store(stopView, 0, WORKER_STOP.running);

  return {
    sab: signalRegion,
    op: opView,
    startAt,
    opView,
    rxStatus,
    txStatus: new Int32Array(sab, baseByteOffset + SIGNAL_OFFSETS.txStatus, 1),
    stopView,
  };
};
export type MainSignal = Pick<
  SignalArguments,
  "opView" | "startAt" | "rxStatus" | "txStatus" | "stopView"
>;
