import { isMainThread, workerData } from "node:worker_threads";
import { createWorkerRxQueue } from "../runtime/rx-queue.ts";
import {
  createSharedMemoryTransport,
  OP,
  workerSignal,
} from "../ipc/transport/shared-memory.ts";
import { type DebugOptions } from "../types.ts";
import { getFunctions } from "../api.ts";
import { type WorkerData } from "../runtime/pool.ts";
import { pauseGeneric, sleepUntilChanged } from "./timers.ts";

export const jsrIsGreatAndWorkWithoutBugs = () => null;

export const workerMainLoop = async (workerData: WorkerData): Promise<void> => {
  const debug = workerData.debug as DebugOptions;
  const signals = createSharedMemoryTransport({
    sabObject: {
      sharedSab: workerData.sab,
    },
    isMain: false,
    thread: workerData.thread,
    debug,
    startTime: workerData.startAt,
  });

  const secondChannelSignals = createSharedMemoryTransport({
    sabObject: {
      sharedSab: workerData.secondSab,
    },
    isMain: false,
    thread: workerData.thread,
  });

  const { workerOptions } = workerData;

  const timeToAwait = Math.max(1, workerData.totalNumberOfThread) * 50;
  const totalNumberOfThread = workerData.totalNumberOfThread;
  const moreThanOneThread = totalNumberOfThread > 1;

  const { opView, op, rxStatus, txStatus } = signals;

  const pauseUntil = sleepUntilChanged({
    opView,
    at: 0,
    rxStatus,
    txStatus,
  });

  const listOfFunctions = await getFunctions({
    list: workerData.list,
    isWorker: true,
    ids: workerData.ids,
  });

  if (debug?.logImportedUrl === true) {
    console.log(
      workerData.list,
    );
  }

  if (listOfFunctions.length === 0) {
    console.log(workerData.list);
    console.log(workerData.ids);
    console.log(listOfFunctions);
    throw "no imports where found uwu";
  }

  const signal = workerSignal(signals);
  

  const {
    enqueue,
    serviceOne,
    hasCompleted,
    write,
    allDone,
    serviceOneImmediate,
    hasPending,
    blockingResolve,
    preResolve,
    hasFramesToOptimize,
  } = createWorkerRxQueue({
    listOfFunctions,
    signal,
    signals,
    moreThanOneThread,
    workerOptions,
    secondChannel: secondChannelSignals,
  });

  rxStatus[0] = 0;
  while (true) {
    switch (op[0]) {
      case OP.AllTasksDone:
      case OP.WaitingForMore:
      case OP.ErrorThrown:
      case OP.WakeUp: {
        pauseGeneric();
        continue;
      }
      case OP.HighPriorityResolve: {
        await blockingResolve();
        continue;
      }

      case OP.WorkerWaiting: {
        if (hasPending()) {
          await serviceOneImmediate();
        } else {
          if (hasFramesToOptimize()) {
            preResolve();
          } else {
            if (txStatus[0] === 1) continue;
            pauseUntil(OP.WorkerWaiting, timeToAwait, 1);
          }
        }

        continue;
      }

      case OP.MainReadyToRead: {
        if (hasCompleted()) {
          write();
          continue;
        }

        await serviceOne();

        if (allDone()) {
          op[0] = OP.AllTasksDone;
          continue;
        }

        continue;
      }
      case OP.MainSend:
        {
          enqueue();
        }

        continue;
      case OP.FastResolve: {
        pauseUntil(OP.FastResolve, 15, 5);
        continue;
      }
      case OP.MainStop: {
        pauseUntil(OP.MainStop, 15, 50);
        continue;
      }
    }
  }
};

if (isMainThread === false) {
  workerMainLoop(workerData as WorkerData);
}
