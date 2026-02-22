// main.ts

import { createHostTxQueue } from "./tx-queue.ts";
import {
  createSharedMemoryTransport,
  mainSignal,
  type Sab,
} from "../ipc/transport/shared-memory.ts";
import { ChannelHandler, hostDispatcherLoop } from "./dispatcher.ts";
import {
  HEADER_BYTE_LENGTH,
  LOCK_SECTOR_BYTE_LENGTH,
  lock2,
  type PromisePayloadResult,
  type Task,
} from "../memory/lock.ts";
import type {
  DebugOptions,
  DispatcherSettings,
  LockBuffers,
  WorkerCall,
  WorkerContext,
  WorkerData,
  WorkerSettings,
} from "../types.ts";
import { jsrIsGreatAndWorkWithoutBugs } from "../worker/loop.ts";
import { HAS_SAB_GROW, createSharedArrayBuffer } from "../common/runtime.ts";
import { signalAbortFactory } from "../shared/abortSignal.ts";
import { Worker } from "node:worker_threads";

enum Comment {
  thisIsAHint = 0,
}

//const isBrowser = typeof window !== "undefined";

let poliWorker = Worker;

export const spawnWorkerContext = ({
  list,
  ids,
  sab,
  thread,
  debug,
  totalNumberOfThread,
  source,
  at,
  workerOptions,
  workerExecArgv,
  host,
  payloadInitialBytes,
  payloadMaxBytes,
  usesAbortSignal,
}: {
  list: string[];
  ids: number[];
  at: number[];
  sab?: Sab;
  thread: number;
  debug?: DebugOptions;
  totalNumberOfThread: number;

  source?: string;
  workerOptions?: WorkerSettings;
  workerExecArgv?: string[];
  host?: DispatcherSettings;
  payloadInitialBytes?: number;
  payloadMaxBytes?: number;
  usesAbortSignal?: boolean;
}) => {
  const tsFileUrl = new URL(import.meta.url);

  if (debug?.logHref === true) {
    console.log(tsFileUrl);
    jsrIsGreatAndWorkWithoutBugs();
  }

  // Lock buffers must be shared between host and worker.
  const defaultPayloadMaxBytes = 64 * 1024 * 1024;
  const sanitizeBytes = (value: number | undefined) => {
    if (!Number.isFinite(value)) return undefined;
    const bytes = Math.floor(value as number);
    return bytes > 0 ? bytes : undefined;
  };
  const maxBytes = sanitizeBytes(payloadMaxBytes) ?? defaultPayloadMaxBytes;
  const requestedInitial = sanitizeBytes(payloadInitialBytes);
  const initialBytes = HAS_SAB_GROW
    ? Math.min(requestedInitial ?? (4 * 1024 * 1024), maxBytes)
    : maxBytes;

  const lockBuffers: LockBuffers = {
    lockSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
    payloadSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
    headers: new SharedArrayBuffer(HEADER_BYTE_LENGTH),
    payload: createSharedArrayBuffer(
      initialBytes,
      maxBytes,
    ),
  };
  const returnLockBuffers: LockBuffers = {
    lockSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
    payloadSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
    headers: new SharedArrayBuffer(HEADER_BYTE_LENGTH),
    payload: createSharedArrayBuffer(
      initialBytes,
      maxBytes,
    ),
  };

  const lock = lock2({
    headers: lockBuffers.headers,
    LockBoundSector: lockBuffers.lockSector,
    payload: lockBuffers.payload,
    payloadSector: lockBuffers.payloadSector,
  });
  const returnLock = lock2({
    headers: returnLockBuffers.headers,
    LockBoundSector: returnLockBuffers.lockSector,
    payload: returnLockBuffers.payload,
    payloadSector: returnLockBuffers.payloadSector,
  });
  const abortSignalSAB = usesAbortSignal === true
    ? new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT * 1024)
    : undefined;
  const abortSignals = abortSignalSAB
    ? signalAbortFactory({ sab: abortSignalSAB })
    : undefined;

  const signals = createSharedMemoryTransport({
    sabObject: sab,
    isMain: true,
    thread,
    debug,
  });
  const signalBox = mainSignal(signals);

  const queue = createHostTxQueue({
    lock,
    returnLock,
    abortSignals,
  });

  const {
    enqueue,
    rejectAll,
    txIdle,
  } = queue;
  const channelHandler = new ChannelHandler();

  const { check, fastCheck } = hostDispatcherLoop({
    signalBox,
    queue,
    channelHandler,
    dispatcherOptions: host,
    //thread,
    //debugSignal: debug?.logMain ?? false,
    //perf,
  });

  channelHandler.open(check);

  //@ts-ignore

  let worker;

  const workerUrl = source ?? (
    // isBrowser
    //   ? tsFileUrl.href // correct in browser
    //   :
    tsFileUrl
  );
  const workerDataPayload = {
    sab: signals.sab,
    abortSignalSAB,
    list,
    ids,
    at,
    thread,
    debug,
    workerOptions,
    totalNumberOfThread,
    startAt: signalBox.startAt,
    lock: lockBuffers,
    returnLock: returnLockBuffers,
  } as WorkerData;
  const baseWorkerOptions = {
    //@ts-ignore Reason
    type: "module",
    //@ts-ignore
    workerData: workerDataPayload,
  } as {
    type: "module";
    workerData: WorkerData;
    execArgv?: string[];
  };
  const withExecArgv = workerExecArgv && workerExecArgv.length > 0
    ? { ...baseWorkerOptions, execArgv: workerExecArgv }
    : baseWorkerOptions;
  try {
    worker = new poliWorker(workerUrl, withExecArgv) as Worker;
  } catch (error) {
    if ((error as { code?: string })?.code === "ERR_WORKER_INVALID_EXEC_ARGV") {
      worker = new poliWorker(workerUrl, baseWorkerOptions) as Worker;
    } else {
      throw error;
    }
  }

  const thisSignal = signalBox.opView;
  const a_add = Atomics.add;
  const a_load = Atomics.load;
  const a_notify = Atomics.notify;
  const scheduleFastCheck = queueMicrotask;

  const send = () => {
    if (check.isRunning === true) return;
    // Macro lane: dispatcher check is driven by the channel callback.
    channelHandler.notify();
    check.isRunning = true;

    // Use opView as a wake counter in lock2 mode to avoid lost wakeups.
    if (a_load(signalBox.rxStatus, 0) === 0) {
      a_add(thisSignal, 0, 1);
      a_notify(thisSignal, 0, 1);
    }
  };

  lock.setPromiseHandler((task: Task, result: PromisePayloadResult) => {
    queue.settlePromisePayload(task, result);
    send();
  });

  const call = ({ fnNumber, timeout, abortSignal }: WorkerCall) => {
    const enqueues = enqueue(fnNumber, timeout, abortSignal);

    return (args: Uint8Array) => {
      const pending = enqueues(args);

      if (fastCheck.isRunning === false) {
        // Prevent worker from sleeping before the dispatcher loop starts.
        // Best-effort hint only; non-atomic by design.
        signalBox.txStatus[Comment.thisIsAHint] = 1;
        fastCheck.isRunning = true;
        scheduleFastCheck(fastCheck);
        send();
      }

      return pending;
    };
  };

  const context: WorkerContext & { lock: ReturnType<typeof lock2> } = {
    txIdle,
    call,
    kills: async () => {
      rejectAll("Thread closed");
      channelHandler.close();
      try {
        void Promise.resolve(worker.terminate()).catch(() => {});
      } catch {
      }
    },
    lock,
  };

  return context;
};

export type CreateContext = WorkerContext;
