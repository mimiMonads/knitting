// main.ts
import { Worker } from "node:worker_threads";
import { createMainQueue, type PromiseMap } from "./mainQueueManager.ts";
import { genTaskID } from "./utils.ts";
import { mainSignal, type Sab, signalsForWorker } from "./signals.ts";
import { ChannelHandler, taskScheduler } from "./taskScheduler.ts";
import type { ComposedWithKey, DebugOptions } from "./taskApi.ts";
import { jsrIsGreatAndWorkWithoutBugs } from "./workerThread.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const createContext = ({
  promisesMap,
  list,
  ids,
  sab,
  thread,
  debug,
  listOfFunctions,
  perf,
}: {
  promisesMap: PromiseMap;
  list: string[];
  ids: number[];
  sab?: Sab;
  thread: number;
  debug?: DebugOptions;
  listOfFunctions: ComposedWithKey[];
  perf?: number;
}) => {
  // Determine worker file URL based on file existence
  const jsFileUrl = new URL("workerThread.js", import.meta.url);
  const tsFileUrl = new URL("workerThread.ts", import.meta.url);

  // Convert URL to file path for the file system check
  const jsFilePath = fileURLToPath(
    //@ts-ignore
    jsFileUrl,
  );

  let workerUrl: URL;
  if (existsSync(jsFilePath)) {
    // Use the compiled JavaScript file if it exists.
    workerUrl = jsFileUrl;
  } else {
    // Otherwise, fall back to the TypeScript file in development.
    workerUrl = tsFileUrl;
  }

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
    perf,
  });

  channelHandler.open(check);

  const worker = new Worker(
    fileURLToPath(
      //@ts-ignore
      workerUrl,
    ),
    {
      //@ts-ignore Reason
      type: "module",
      workerData: {
        sab: signals.sab,
        list,
        ids,
        thread,
        debug,
      },
    },
  );

  type CallFunction = {
    fnNumber: number;
  };

  const callFunction = ({ fnNumber }: CallFunction) => {
    const enqueues = enqueuePromise(fnNumber);
    return (args: Uint8Array) => enqueues(args);
  };

  const send = ((starts: typeof dispatchToWorker) => () => {
    if (check.isRunning === false && canWrite()) {
      signalBox.status[0] = 9;
      Atomics.notify(signalBox.status, 0, 1);
      starts();
      check.isRunning = true;
      queueMicrotask(check);
    }
  })(dispatchToWorker);

  const fastCalling = ({ fnNumber }: CallFunction) => {
    const first = fastEnqueue(fnNumber);
    const enqueue = enqueuePromise(fnNumber);

    return (args: Uint8Array) => {
      return check.isRunning === false
        ? (
          check.isRunning = true, queueMicrotask(check), first(args)
        )
        : enqueue(args);
    };
  };

  return {
    queue,
    check,
    dispatchToWorker,
    send,
    callFunction,
    fastCalling,
    kills: () => (
      rejectAll("Thread closed"), channelHandler.close(), worker.terminate()
    ),
  };
};

export type CreateContext = ReturnType<typeof createContext>;
