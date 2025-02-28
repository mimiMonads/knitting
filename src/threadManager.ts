// main.ts
import { Worker } from "node:worker_threads";
import {
  createMainQueue,
  type MultiQueue,
  type PromiseMap,
} from "./mainQueueManager.ts";
import { genTaskID, readPayload, sendPayload } from "./utils.ts";
import { mainSignal, type Sab, signalsForWorker } from "./signals.ts";
import { ChannelHandler, taskScheduler } from "./taskScheduler.ts";

export const createContext = ({
  promisesMap,
  list,
  ids,
  sab,
  thread,
}: {
  promisesMap: PromiseMap;
  list: string[];
  ids: number[];
  sab?: Sab;
  thread?: number;
}) => {
  const currentPath = import.meta.url;
  const workerUrl = new URL(
    currentPath.replace("threadManager.ts", "workerThread.ts"),
  );

  const signals = signalsForWorker(sab);
  const signalBox = mainSignal(signals);

  const writer = sendPayload(signals);
  const reader = readPayload(signals);

  const queue = createMainQueue({
    writer,
    signalBox,
    reader,
    genTaskID,
    promisesMap,
  });

  const { enqueue, awaits, awaitArray, dispatchToWorker, fastEnqueue } = queue;
  const channelHandler = new ChannelHandler();

  const check = taskScheduler({
    signalBox,
    queue,
    channelHandler,
  });

  channelHandler.open(check);

  const worker = new Worker(workerUrl, {
    //@ts-ignore Reason -> This is a Deno only thing
    type: "module",
    workerData: {
      sab: signals.sab,
      list,
      ids,
    },
  });

  const isActive = ((status: Int32Array) => (n: number) => {
    if (check.isRunning === false) {
      dispatchToWorker();
      check.isRunning = true;
      queueMicrotask(check);
      //new Promise(() => check())
    }

    return n;
  })(signals.status);



  type CallFunction = {
    fnNumber: number;
    statusSignal: 224 | 192;
  };

  const callFunction = ({fnNumber, statusSignal}: CallFunction) => {
    const enqueues = enqueue(statusSignal)(fnNumber);
    return (args: Uint8Array) => awaits(isActive(enqueues(args)));
  };

  const run = ((starts : typeof dispatchToWorker) => () => {

    if (check.isRunning === false) {
      starts();
      check.isRunning = true;
      queueMicrotask(check);
    }

  })(dispatchToWorker);

  const fastCalling = ({fnNumber, statusSignal}:CallFunction ) => {
    const start =  fastEnqueue(statusSignal)(fnNumber)
    return start
  }


  return {
    queue,
    run,
    callFunction,
    isActive,
    fastCalling,
    awaitArray,
    kills: () => (
      channelHandler.close(), worker.terminate()
    ),
  };
};
