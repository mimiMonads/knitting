// main.ts

import { createMainQueue, type PromiseMap } from "./mainQueueManager.ts";
import { genTaskID } from "./utils.ts";
import {
  mainSignal,
  type Sab,
  signalsForWorker,
  SignalStatus,
} from "./signals.ts";
import { ChannelHandler, taskScheduler } from "./taskScheduler.ts";
import type { ComposedWithKey, DebugOptions } from "./taskApi.ts";
import { jsrIsGreatAndWorkWithoutBugs } from "./workerThread.ts";

const isBrowser = typeof window !== "undefined";

let poliWorker: Worker;

if (!isBrowser) {
  const { Worker } = await import("node:worker_threads");
  //@ts-ignore
  poliWorker = Worker;
} else {
  //@ts-ignore
  poliWorker = Worker;
}

export type CallFunction = {
  fnNumber: number;
};

export type WorkerData = {
  sab: SharedArrayBuffer;
  list: string[];
  ids: number[];
  thread: number;
  debug?: DebugOptions;
};

export const createContext = ({
  promisesMap,
  list,
  ids,
  sab,
  thread,
  debug,
  listOfFunctions,
  perf,
  source,
}: {
  promisesMap: PromiseMap;
  list: string[];
  ids: number[];
  sab?: Sab;
  thread: number;
  debug?: DebugOptions;
  listOfFunctions: ComposedWithKey[];
  perf?: number;
  source?: string;
}) => {
  const tsFileUrl = new URL("workerThread.ts", import.meta.url);

  if (debug?.logHref === true) {
    console.log(tsFileUrl);
    jsrIsGreatAndWorkWithoutBugs();
  }

  const signals = signalsForWorker(sab);
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
    canWrite,
    rejectAll,
    isEverythingSolved,
  } = queue;
  const channelHandler = new ChannelHandler();

  const check = taskScheduler({
    signalBox,
    queue,
    channelHandler,
    thread,
    debugSignal: debug?.logMain ?? false,
    perf,
  });

  channelHandler.open(check);

  //@ts-ignore
  const worker = new poliWorker(
    source ?? (
      isBrowser
        ? tsFileUrl.href // correct in browser
        : decodeURIComponent(tsFileUrl.pathname) // correct in Node
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
      } as WorkerData,
    },
  ) as Worker;

  const callFunction = ({ fnNumber }: CallFunction) => {
    const enqueues = enqueuePromise(fnNumber);
    return (args: Uint8Array) => enqueues(args);
  };

  const send = () => {
    if (check.isRunning === false && canWrite()) {
      signalBox.status[0] = SignalStatus.DoNothing;
      Atomics.notify(signalBox.status, 0, 1);
      dispatchToWorker();
      check.isRunning = true;
      queueMicrotask(check);
    }
  };

  const fastCalling = ({ fnNumber }: CallFunction) => {
    const first = fastEnqueue(fnNumber);
    const enqueue = enqueuePromise(fnNumber);

    return (args: Uint8Array) =>
      check.isRunning === false
        ? (
          signalBox.status[0] = SignalStatus.DoNothing,
            Atomics.notify(signalBox.status, 0, 1),
            check.isRunning = true,
            queueMicrotask(check),
            first(args)
        )
        : enqueue(args);
  };

  return {
    isEverythingSolved,
    send,
    callFunction,
    fastCalling,
    kills: () => (
      rejectAll("Thread closed"), channelHandler.close(), worker.terminate()
    ),
  };
};

export type CreateContext = ReturnType<typeof createContext>;
