export type SignalArguments = ReturnType<typeof createSharedMemoryTransport>;
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
  { sabObject, isMain, startTime }: SignalForWorker,
) => {
  const toGrow = sabObject?.size ?? page;
  const roundedSize = toGrow + ((page - (toGrow % page)) % page);
  const sab = sabObject?.sharedSab
    ? sabObject.sharedSab
    : createSharedArrayBuffer(
      roundedSize,
      page * page,
    );

  const startAt = startTime ?? performance.now();
  const opView = new Int32Array(sab, SIGNAL_OFFSETS.op, 1);
  if (isMain) a_store(opView, 0, 0);

  const rxStatus = new Int32Array(sab, SIGNAL_OFFSETS.rxStatus, 1);

  a_store(rxStatus, 0, 1);
  return {
    sab,
    op: opView,
    startAt,
    opView,
    rxStatus,
    txStatus: new Int32Array(sab, SIGNAL_OFFSETS.txStatus, 1),
  };
};
export type MainSignal = Pick<
  SignalArguments,
  "opView" | "startAt" | "rxStatus" | "txStatus"
>;
