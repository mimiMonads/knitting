// main.ts

import { createHostTxQueue } from "./tx-queue.ts";
import {
  createSharedMemoryTransport,
  mainSignal,
  type Sab,
} from "../ipc/transport/shared-memory.ts";
import { ChannelHandler, hostDispatcherLoop } from "./dispatcher.ts";
import { lock2, LockBound, TaskIndex } from "../memory/lock.ts";
import type {
  DebugOptions,
  LockBuffers,
  WorkerCall,
  WorkerContext,
  WorkerData,
  WorkerSettings,
} from "../types.ts";
import { jsrIsGreatAndWorkWithoutBugs } from "../worker/loop.ts";
import { Worker } from "node:worker_threads";

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
}) => {
  const tsFileUrl = new URL(import.meta.url);

  if (debug?.logHref === true) {
    console.log(tsFileUrl);
    jsrIsGreatAndWorkWithoutBugs();
  }

  // Lock buffers must be shared between host and worker.
  const lockBuffers: LockBuffers = {
    lockSector: new SharedArrayBuffer(
      LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    ),
    headers: new SharedArrayBuffer(
      LockBound.padding +
        (LockBound.slots * TaskIndex.TotalBuff) * LockBound.slots,
    ),
    payload: new SharedArrayBuffer(
      64 * 1024 * 1024,
      { maxByteLength: 64 * 1024 * 1024 },
    ),
  };
  const returnLockBuffers: LockBuffers = {
    lockSector: new SharedArrayBuffer(
      LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    ),
    headers: new SharedArrayBuffer(
      LockBound.padding +
        (LockBound.slots * TaskIndex.TotalBuff) * LockBound.slots,
    ),
    payload: new SharedArrayBuffer(
      64 * 1024 * 1024,
      { maxByteLength: 64 * 1024 * 1024 },
    ),
  };

  const lock = lock2({
    headers: lockBuffers.headers,
    LockBoundSector: lockBuffers.lockSector,
    payload: lockBuffers.payload,
  });
  const returnLock = lock2({
    headers: returnLockBuffers.headers,
    LockBoundSector: returnLockBuffers.lockSector,
    payload: returnLockBuffers.payload,
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
    //thread,
    //debugSignal: debug?.logMain ?? false,
    //perf,
  });

  channelHandler.open(check);

  //@ts-ignore

  let worker;

  worker = new poliWorker(
    source ?? (
      // isBrowser
      //   ? tsFileUrl.href // correct in browser
      //   :
      tsFileUrl
    ),
    {
      //@ts-ignore Reason
      type: "module",
      //@ts-ignore
      workerData: {
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
      } as WorkerData,
    },
  ) as Worker;

  const thisSignal = signalBox.opView;
  const send = () => {
    if (check.isRunning === true) return;

    // Prevent worker from sleeping before the dispatcher loop starts.
    signalBox.txStatus[0] = 1;
    // Use opView as a wake counter in lock2 mode to avoid lost wakeups.
    Atomics.add(thisSignal, 0, 1);
    if (signalBox.rxStatus[0] === 0) {
      Atomics.notify(thisSignal, 0, 1);
    }
    check.isRunning = true;
    Promise.resolve().then(check);
  };

  const call = ({ fnNumber }: WorkerCall) => {
    const enqueues = enqueue(fnNumber);
    return (args: Uint8Array) => {

      const pro = enqueues(args)
      
      if (check.isRunning === false) {
        check.isRunning = true;
        // Prevent worker from sleeping before the dispatcher loop starts.
        signalBox.txStatus[0] = 1;
        // Use opView as a wake counter in lock2 mode to avoid lost wakeups.
        Atomics.add(thisSignal, 0, 1);
        if (signalBox.rxStatus[0] === 0) {
          Atomics.notify(thisSignal, 0, 1);
        }
        Promise.resolve().then(check);
      }

      return pro;
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
