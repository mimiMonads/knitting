// main.ts

import { createHostTxQueue } from "./tx-queue.ts";
import { beat, genTaskID } from "../common/others.ts";
import {
  createSharedMemoryTransport,
  mainSignal,
  OP,
  type Sab,
} from "../ipc/transport/shared-memory.ts";
import { ChannelHandler, hostDispatcherLoop } from "./dispatcher.ts";
import { lock2, LockBound, TaskIndex } from "../memory/lock.ts";
import type {
  ComposedWithKey,
  DebugOptions,
  LockBuffers,
  PromiseMap,
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
  promisesMap,
  list,
  ids,
  sab,
  thread,
  debug,
  listOfFunctions,
  totalNumberOfThread,
  source,
  at,
  workerOptions,
  useLock,
}: {
  promisesMap: PromiseMap;
  list: string[];
  ids: number[];
  at: number[];
  sab?: Sab;
  thread: number;
  debug?: DebugOptions;
  totalNumberOfThread: number;
  listOfFunctions: ComposedWithKey[];
  perf?: number;

  source?: string;
  workerOptions?: WorkerSettings;
  useLock?: boolean;
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

  const lock = lock2({
    headers: lockBuffers.headers,
    LockBoundSector: lockBuffers.lockSector,
    payload: lockBuffers.payload,
  });

  const signals = createSharedMemoryTransport({
    sabObject: sab,
    isMain: true,
    thread,
    debug,
  });
  const secondChannelSignals = createSharedMemoryTransport({
    isMain: true,
    thread,
  });

  const signalBox = mainSignal(signals);

  const queue = createHostTxQueue({
    signalBox,
    secondChannel: secondChannelSignals,
    genTaskID,
    promisesMap,
    listOfFunctions,
    signals,
    lock,
    useLock,
  });

  const {
    flushToWorker,
    postImmediate,
    enqueue,
    hasPendingFrames,
    rejectAll,
    txIdle,
  } = queue;
  const channelHandler = new ChannelHandler();

  const check = hostDispatcherLoop({
    signalBox,
    queue,
    channelHandler,
    totalNumberOfThread,
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
        secondSab: secondChannelSignals.sab,
        startAt: signalBox.startAt,
        lock: lockBuffers,
      } as WorkerData,
    },
  ) as Worker;

  const thisSignal = signalBox.opView;
  const send = () => {
    if (check.isRunning === false && hasPendingFrames()) {
      thisSignal[0] = OP.WakeUp;
      Atomics.notify(thisSignal, 0, 1);
      flushToWorker();
      check.isRunning = true;
      Promise.resolve().then(check);
    }
  };

  const call = ({ fnNumber }: WorkerCall) => {
    const enqueues = enqueue(fnNumber);
    return (args: Uint8Array) => {
      if (check.isRunning === false && hasPendingFrames()) {
        check.isRunning = true;
        thisSignal[0] = OP.WakeUp;
        Atomics.notify(thisSignal, 0, 1);
        Promise.resolve().then(() => (flushToWorker(), check()));
      }

      return enqueues(args);
    };
  };

  const fastCalling = ({ fnNumber }: WorkerCall) => {
    const first = postImmediate(fnNumber);
    const enqueued = enqueue(fnNumber);
    const thisSignal = signalBox.opView;
    return (args: Uint8Array) =>
      check.isRunning === false
        // Avoid weird optimizations from the runtime
        ? (
          thisSignal[0] = OP.WakeUp,
            Atomics.notify(thisSignal, 0, 1),
            check.isRunning = true,
            Promise.resolve().then(check),
            first(args)
        )
        : enqueued(args);
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
