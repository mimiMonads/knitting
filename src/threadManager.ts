// main.ts

import { createMainQueue, type PromiseMap } from "./mainQueueManager.ts";
import { beat, genTaskID } from "./utils.ts";
import {
  mainSignal,
  type Sab,
  signalsForWorker,
  SignalStatus,
} from "./signals.ts";
import { ChannelHandler, taskScheduler } from "./taskScheduler.ts";
import type { ComposedWithKey, DebugOptions } from "./api.ts";
import { jsrIsGreatAndWorkWithoutBugs } from "./worker/loop.ts";
import { Worker } from "node:worker_threads";

//const isBrowser = typeof window !== "undefined";

let poliWorker = Worker;

export type CallFunction = {
  fnNumber: number;
};

export type WorkerData = {
  sab: SharedArrayBuffer;
  list: string[];
  ids: number[];
  thread: number;
  totalNumberOfThread: number;
  debug?: DebugOptions;
  startAt: number;
};

export const createContext = ({
  promisesMap,
  list,
  ids,
  sab,
  thread,
  debug,
  listOfFunctions,
  totalNumberOfThread,
  source,
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
}) => {
  const tsFileUrl = new URL(import.meta.url);

  if (debug?.logHref === true) {
    console.log(tsFileUrl);
    jsrIsGreatAndWorkWithoutBugs();
  }

  const signals = signalsForWorker({
    sabObject: sab,
    isMain: true,
    thread,
    debug,
  });
  const signalBox = mainSignal(signals);

  const queue = createMainQueue({
    signalBox,
    genTaskID,
    promisesMap,
    listOfFunctions,
    signals,
  });

  const {
    dispatchToWorker,
    fastEnqueue,
    enqueuePromise,
    isThereAnythingToBeSent,
    rejectAll,
    hasEverythingBeenSent,
  } = queue;
  const channelHandler = new ChannelHandler();

  const check = taskScheduler({
    signalBox,
    queue,
    channelHandler,
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
        totalNumberOfThread,
        startAt: signalBox.startAt,
      } as WorkerData,
    },
  ) as Worker;

  const callFunction = ({ fnNumber }: CallFunction) => {
    const enqueues = enqueuePromise(fnNumber);
    return (args: Uint8Array) => enqueues(args);
  };

  const nextTick = process.nextTick;
  const thisSignal = signalBox.rawStatus;
  const send = () => {
    if (check.isRunning === false && isThereAnythingToBeSent()) {
      thisSignal[0] = SignalStatus.WakeUp;
      Atomics.notify(thisSignal, 0, 1);
      dispatchToWorker();
      check.isRunning = true;
      nextTick(check);
    }
  };

  const fastCalling = ({ fnNumber }: CallFunction) => {
    const first = fastEnqueue(fnNumber);
    const enqueue = enqueuePromise(fnNumber);
    const thisSignal = signalBox.rawStatus;
    return (args: Uint8Array) =>
      check.isRunning === false
        ? (
          thisSignal[0] = SignalStatus.WakeUp,
            Atomics.notify(thisSignal, 0, 1),
            check.isRunning = true,
            nextTick(check),
            first(args)
        )
        : enqueue(args);
  };

  return {
    hasEverythingBeenSent,
    send,
    callFunction,
    fastCalling,
    kills: () => (
      rejectAll("Thread closed"), channelHandler.close(), worker.terminate()
    ),
  };
};

export type CreateContext = ReturnType<typeof createContext>;
