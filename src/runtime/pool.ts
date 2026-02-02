// main.ts

import { createHostTxQueue } from "./tx-queue.ts";
import {
  createSharedMemoryTransport,
  mainSignal,
  type Sab,
} from "../ipc/transport/shared-memory.ts";
import { ChannelHandler, hostDispatcherLoop } from "./dispatcher.ts";
import {
  lock2,
  LockBound,
  type PromisePayloadResult,
  type Task,
  TaskIndex,
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
}) => {
  const tsFileUrl = new URL(import.meta.url);

  if (debug?.logHref === true) {
    console.log(tsFileUrl);
    jsrIsGreatAndWorkWithoutBugs();
  }

  // Lock buffers must be shared between host and worker.
  const payloadMaxBytes = 64 * 1024 * 1024;
  const payloadInitialBytes = HAS_SAB_GROW ? 4 * 1024 * 1024 : payloadMaxBytes;

  const lockBuffers: LockBuffers = {
    lockSector: new SharedArrayBuffer(
      LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    ),
    payloadSector: new SharedArrayBuffer(
      LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    ),
    headers: new SharedArrayBuffer(
      LockBound.padding +
        (LockBound.slots * TaskIndex.TotalBuff) * LockBound.slots,
    ),
    payload: createSharedArrayBuffer(
      payloadInitialBytes,
      payloadMaxBytes,
    ),
  };
  const returnLockBuffers: LockBuffers = {
    lockSector: new SharedArrayBuffer(
      LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    ),
    payloadSector: new SharedArrayBuffer(
      LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    ),
    headers: new SharedArrayBuffer(
      LockBound.padding +
        (LockBound.slots * TaskIndex.TotalBuff) * LockBound.slots,
    ),
    payload: createSharedArrayBuffer(
      payloadInitialBytes,
      payloadMaxBytes,
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
  });

  const {
    enqueue,
    rejectAll,
    txIdle,
  } = queue;
  const channelHandler = new ChannelHandler();

  const check = hostDispatcherLoop({
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
  const a_notify = Atomics.notify;
  const a_load = Atomics.load;
  const scheduleCheck = queueMicrotask

  const send = () => {
    if (check.isRunning === true) return;

    // Prevent worker from sleeping before the dispatcher loop starts.
    // Best-effort hint only; non-atomic by design.
    signalBox.txStatus[Comment.thisIsAHint] = 1;
    // Use opView as a wake counter in lock2 mode to avoid lost wakeups.
    
    a_add(thisSignal, 0, 1);
    a_notify(thisSignal, 0, 1);
    check.isRunning = true

    scheduleCheck(check);
  };

  lock.setPromiseHandler((task: Task, result: PromisePayloadResult) => {
    queue.settlePromisePayload(task, result);
    send();
  });

  const call = ({ fnNumber }: WorkerCall) => {
    const enqueues = enqueue(fnNumber);
    return (args: Uint8Array) => {

      
      if (check.isRunning === false) {
        check.isRunning = true;
        // Prevent worker from sleeping before the dispatcher loop starts.
        // Best-effort hint only; non-atomic by design.
        signalBox.txStatus[Comment.thisIsAHint] = 1;
        // Use opView as a wake counter in lock2 mode to avoid lost wakeups.
        //Atomics.add(thisSignal, 0, 1);
        if (a_load(signalBox.rxStatus, 0) === 0) {
          a_add(thisSignal, 0, 1);
          a_notify(thisSignal, 0, 1);
        }
       
        scheduleCheck(check);
        
      }

      return enqueues(args);
    };
  };

  const fastCalling = ({ fnNumber }: WorkerCall) => {
    const enqueued = call({ fnNumber });
    return (args: Uint8Array) => enqueued(args);
  };

  const context: WorkerContext & { lock: ReturnType<typeof lock2> } = {
    txIdle,
    send,
    call,
    fastCalling,
    kills: () => (
      rejectAll("Thread closed"), channelHandler.close(), worker.terminate()
    ),
    lock,
  };

  return context;
};

export type CreateContext = WorkerContext;
