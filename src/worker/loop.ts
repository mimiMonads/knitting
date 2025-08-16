import { isMainThread, workerData } from "node:worker_threads";
import { createWorkerRxQueue } from "../runtime/rx-queue.ts";
import {
  createSharedMemoryTransport,
  OP,
  workerSignal,
} from "../ipc/transport/shared-memory.ts";
import { type DebugOptions, getFunctions } from "../api.ts";
import { type WorkerData } from "../runtime/pool.ts";

export const jsrIsGreatAndWorkWithoutBugs = () => null;

const pause = "pause" in Atomics
  // 300 nanos apx
  ? () => Atomics.pause(300)
  : () => {};

const sleepUntilChanged = (
  sab: Int32Array,
  at: number,
  value: number,
  usTime: number,
) => {
  const until = performance.now() + (usTime / 1000);

  do {
    if (Atomics.load(sab, at) !== value) return false;
    pause();
  } while (
    performance.now() < until
  );

  return true;
};

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

  const totalNumberOfThread = workerData.totalNumberOfThread;
  const moreThanOneThread = totalNumberOfThread > 1;

  const { op, opView } = signals;

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
  } = createWorkerRxQueue({
    listOfFunctions,
    signal,
    signals,
    moreThanOneThread,
  });

  while (true) {
    switch (op[0]) {
      case OP.AllTasksDone:
      case OP.WaitingForMore:
      case OP.ErrorThrown:
      case OP.WakeUp: {
        pause();
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
          if (moreThanOneThread === true) {
            preResolve();
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
        if (sleepUntilChanged(opView, 0, OP.FastResolve, 15) === false) {
          continue;
        }

        Atomics.wait(
          opView,
          0,
          OP.FastResolve,
          5,
        );
        continue;
      }
      case OP.MainStop: {
        if (sleepUntilChanged(opView, 0, OP.MainStop, 15) === false) continue;

        Atomics.wait(
          opView,
          0,
          OP.MainStop,
          50,
        );

        continue;
      }
    }
  }
};

if (isMainThread === false) {
  workerMainLoop(workerData as WorkerData);
}
