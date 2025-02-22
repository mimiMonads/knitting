// main.ts
import { Worker } from "node:worker_threads";
import { multi, type MultiQueue, type PromiseMap } from "./mainQueue.ts";
import { genTaskID, readMessageToUint, sendUintMessage } from "./helpers.ts";
import { mainSignal, Sab, signalsForWorker } from "./signal.ts";
import { ChannelHandler, checker } from "./checker.ts";

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
  const workerUrl = new URL(currentPath.replace("main.ts", "worker.ts"));

  const signals = signalsForWorker(sab);
  const signalBox = mainSignal(signals);

  const writer = sendUintMessage(signals);
  const reader = readMessageToUint(signals);

  const queue = multi({
    writer,
    signalBox,
    reader,
    genTaskID,
    promisesMap,
  });

  const { add, awaits, awaitArray } = queue;
  const channelHandler = new ChannelHandler();

  const check = checker({
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

  const isActive = ((status: Int32Array) => () =>
    check.running === false
      ? (
        status[0] = 254, check.running = true, queueMicrotask(check)
      )
      : undefined)(signals.status);

  type Resolver = {
    queue: MultiQueue;
    fnNumber: number;
    statusSignal: 224 | 192;
    max?: number;
  };

  const resolver = (args: Resolver) => {
    const { queue, fnNumber, statusSignal } = args;

    const adds = add(statusSignal)(fnNumber);
    return (args: Uint8Array) => (
      isActive(), awaits(adds(args))
    );
  };

  return {
    queue,
    resolver,
    isActive,
    awaitArray,
    kills: () => (
      channelHandler.close(), worker.terminate()
    ),
  };
};
