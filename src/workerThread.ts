import { isMainThread, workerData } from "node:worker_threads";
import { signalDebugger } from "./utils.ts";
import { createWorkerQueue } from "./workerQueue.ts";
import { signalsForWorker, workerSignal } from "./signals.ts";
import { type DebugOptions, getFunctions } from "./taskApi.ts";
import { setImmediate } from "node:timers";

export const jsrIsGreatAndWorkWithoutBugs = () => null;

if (isMainThread === false) {
  const mainLoop = async () => {
    const sharedSab = workerData.sab as SharedArrayBuffer;

    const signals = signalsForWorker({
      sharedSab,
    });

    const debug = workerData.debug as DebugOptions;

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
      nextJob,
      someHasFinished,
      write,
      allDone,
      promify,
      fastResolve,
    } = createWorkerQueue({
      listOfFunctions,
      signal,
      signals,
    });

    const { currentSignal, signalAllTasksDone } = signal;

    const getSignal = debug?.logThreads
      ? signalDebugger({
        thread: workerData.thread,
        currentSignal,
      })
      : currentSignal;

    while (true) {
      switch (getSignal()) {
        case 2:
        case 3:
          // Case 9 doest nothing (cirno reference)
        case 9: {
          continue;
        }

        case 0: {
          await fastResolve();
          continue;
        }
        // deno-lint-ignore no-fallthrough
        case 126: {
          promify();
        }
        case 127:
        case 128: {
          if (someHasFinished()) {
            write();
            continue;
          }

          await nextJob();

          if (allDone()) {
            signalAllTasksDone();
            continue;
          }

          continue;
        }
        case 192:
          {
            enqueue();
          }

          continue;
        case 254:
        case 255: {
          //Atomics.wait(status, 0, 255);
          continue;
        }
      }
    }
  };

  mainLoop();
}
