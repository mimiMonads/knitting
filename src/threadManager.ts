// main.ts
import { Worker } from "node:worker_threads";
import { createMainQueue, type PromiseMap } from "./mainQueueManager.ts";
import { genTaskID } from "./utils.ts";
import { mainSignal, type Sab, signalsForWorker } from "./signals.ts";
import { ChannelHandler, taskScheduler } from "./taskScheduler.ts";
import { type ComposedWithKey, type DebugOptions } from "./taskApi.ts";
import { jsrIsGreatAndWorkWithoutBugs } from "./workerThread.ts";

export const createContext = ({
  promisesMap,
  list,
  ids,
  sab,
  thread,
  debug,
  listOfFunctions,
}: {
  promisesMap: PromiseMap;
  list: string[];
  ids: number[];
  sab?: Sab;
  thread: number;
  debug?: DebugOptions;
  listOfFunctions: ComposedWithKey[];
}) => {
  const currentPath = import.meta.url;

  const workerUrl = new URL(
    currentPath.replace("threadManager.ts", "workerThread.ts"),
  ).href;

  if (debug?.logHref === true) {
    console.log(workerUrl);
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
  } = queue;
  const channelHandler = new ChannelHandler();

  const check = taskScheduler({
    signalBox,
    queue,
    channelHandler,
    thread,
    debugSignal: debug?.logMain ?? false,
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
      debug,
    },
  });

  type CallFunction = {
    fnNumber: number;
  };

  const callFunction = ({ fnNumber }: CallFunction) => {
    const enqueues = enqueuePromise(fnNumber);
    return (args: Uint8Array) => enqueues(args);
  };

  const send = ((starts: typeof dispatchToWorker) => () => {
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
    send,
    callFunction,
    fastCalling,
    kills: () => (
      rejectAll("Thread closed"), channelHandler.close(), worker.terminate()
    ),
  };
};
