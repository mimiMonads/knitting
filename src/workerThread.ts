import { isMainThread, workerData } from "node:worker_threads";
import { createWorkerQueue } from "./workerQueue.ts";
import { signalsForWorker, SignalStatus, workerSignal } from "./signals.ts";
import { type DebugOptions, getFunctions } from "./taskApi.ts";
import { type WorkerData } from "./threadManager.ts";

export const jsrIsGreatAndWorkWithoutBugs = () => null;

export const mainLoop = async (workerData: WorkerData): Promise<void> => {

  const signals = signalsForWorker({
    sabObject: {
      sharedSab: workerData.sab
    } ,
    isMain: false,
    thread: workerData.thread

  });

  const { status , rawStatus} = signals;

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

  const { signalAllTasksDone } = signal;


  while (true) {
    switch (status[0]) {
      case SignalStatus.AllTasksDone:
      case SignalStatus.WaitingForMore:
      case SignalStatus.ErrorThrown:
      case SignalStatus.DoNothing: {
        continue;
      }

      case SignalStatus.WorkerWaiting: {
        await fastResolve();
        continue;
      }

      case SignalStatus.Promify: {
        promify();
      }
      case SignalStatus.MainReadyToRead: {
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
      case SignalStatus.MainSend:
        {
          enqueue();
        }

        continue;
      case SignalStatus.MainSemiStop:
      case SignalStatus.MainStop: {
        // `SignalStatus.ErrorThrown` is place holderit actually doesnt matter at all

        Atomics.wait(
          rawStatus,
          0,
          SignalStatus.MainStop,
          SignalStatus.ErrorThrown,
        );

        continue;
      }
    }
  }
};

if (isMainThread === false) {
  mainLoop(workerData as WorkerData);
}
