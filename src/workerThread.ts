import { isMainThread, workerData } from "node:worker_threads";
import { signalDebugger } from "./utils.ts";
import { createWorkerQueue } from "./workerQueue.ts";
import { signalsForWorker, workerSignal } from "./signals.ts";
import { type DebugOptions, getFunctions } from "./taskApi.ts";

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

    const { enqueue, nextJob, someHasFinished, write, allDone } =
      createWorkerQueue({
        listOfFunctions,
        signal,
        signals,
      });

    const { currentSignal, signalAllTasksDone, status } = signal;

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
        case 128:
        case 254: 
        case 255: {
          //yieldWhileBusy(status)
          continue;
        }
        case 0: {
          await nextJob();
          continue;
        }
        case 127: {
          await nextJob();

          if (someHasFinished()) {
            write();
            continue;
          }
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
      }
    }
  };

  mainLoop();
}
