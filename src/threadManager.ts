// main.ts
import { Worker } from "node:worker_threads";
import { createMainQueue, type PromiseMap } from "./mainQueueManager.ts";
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
  thread: number;
}) => {
  const currentPath = import.meta.url;
  const workerUrl = new URL(
    currentPath.replace("threadManager.ts", "workerThread.ts"),
  ).href;

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

  const {
    enqueue,
    awaits,
    awaitArray,
    dispatchToWorker,
    fastEnqueue,
    enqueuePromise,
    canWrite,
    rejectAll,
  } = queue;
  const channelHandler = new ChannelHandler();

  const check = taskScheduler({
    signalBox,
    queue,
    channelHandler,
    thread,
  });

  channelHandler.open(check);

  const worker = new Worker(workerUrl, {
    //@ts-ignore Reason -> This is a Deno only thing
    type: "module",
    workerData: {
      sab: signals.sab,
      list,
      ids,
      thread,
    },
  });

  const isActive = ((status: Int32Array) => (n: number) => {
    if (check.isRunning === false) {
      dispatchToWorker();
      check.isRunning = true;
      queueMicrotask(check);
    }

    return n;
  })(signals.status);

  type CallFunction = {
    fnNumber: number;
  };

  const callFunction = ({ fnNumber }: CallFunction) => {
    const enqueues = enqueue(fnNumber);
    return (args: Uint8Array) => awaits(isActive(enqueues(args)));
  };

  const run = ((starts: typeof dispatchToWorker) => () => {
    if (check.isRunning === false && canWrite()) {
      starts();
      check.isRunning = true;
      queueMicrotask(check);
    }
  })(dispatchToWorker);

  const fastCalling = ({ fnNumber }: CallFunction) => {
    const first = fastEnqueue(fnNumber);
    const enqueue = enqueuePromise(fnNumber);

    return (args: Uint8Array) =>
      check.isRunning === false
        ? (
          check.isRunning = true, queueMicrotask(check), first(args)
        )
        : enqueue(args);
  };

  return {
    queue,
    check,
    run,
    callFunction,
    isActive,
    fastCalling,
    awaitArray,

    // Ensured that the thread closses prorperly
    kills: () => (
      rejectAll("Thread closed"), channelHandler.close(), worker.terminate()
    ),
  };
};
