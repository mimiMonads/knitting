// main.ts

import { createHostTxQueue, type PromiseMap } from "./tx-queue.ts";
import { beat, genTaskID } from "../common/others.ts";
import {
  createSharedMemoryTransport,
  mainSignal,
  OP,
  type Sab,
} from "../ipc/transport/shared-memory.ts";
import { ChannelHandler, hostDispatcherLoop } from "./dispatcher.ts";
import type {
  ComposedWithKey,
  DebugOptions,
  WorkerSettings,
} from "../types.ts";
import { jsrIsGreatAndWorkWithoutBugs } from "../worker/loop.ts";
import { Worker } from "node:worker_threads";

//const isBrowser = typeof window !== "undefined";

let poliWorker = Worker;

export type CallFunction = {
  fnNumber: number;
};

export type WorkerData = {
  sab: SharedArrayBuffer;
  secondSab: SharedArrayBuffer;
  list: string[];
  ids: number[];
  thread: number;
  totalNumberOfThread: number;
  debug?: DebugOptions;
  startAt: number;
  workerOptions?: WorkerSettings;
};

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
  workerOptions,
}: {
  promisesMap: PromiseMap;
  list: string[];
  ids: number[];
  sab?: Sab;
  thread: number;
  debug?: DebugOptions;
  totalNumberOfThread: number;
  listOfFunctions: ComposedWithKey[];
  perf?: number;
  source?: string;
  workerOptions?: WorkerSettings;
}) => {
  const tsFileUrl = new URL(import.meta.url);

  if (debug?.logHref === true) {
    console.log(tsFileUrl);
    jsrIsGreatAndWorkWithoutBugs();
  }

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

  let worker = new poliWorker(
    source ?? (
      // isBrowser
      //   ? tsFileUrl.href // correct in browser
      //   :
      decodeURIComponent(tsFileUrl.pathname)
    ),
    {
      //@ts-ignore Reason
      type: "module",
      //@ts-ignore
      workerData: {
        sab: signals.sab,
        list,
        ids,
        thread,
        debug,
        workerOptions,
        totalNumberOfThread,
        secondSab: secondChannelSignals.sab,
        startAt: signalBox.startAt,
      } as WorkerData,
    },
  ) as Worker;

  const callFunction = ({ fnNumber }: CallFunction) => {
    const enqueues = enqueue(fnNumber);
    return (args: Uint8Array) => enqueues(args);
  };

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

  const fastCalling = ({ fnNumber }: CallFunction) => {
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

  return {
    txIdle,
    send,
    callFunction,
    fastCalling,
    kills: () => (
      rejectAll("Thread closed"), channelHandler.close(), worker.terminate()
    ),
  };
};

export type CreateContext = ReturnType<typeof spawnWorkerContext>;
