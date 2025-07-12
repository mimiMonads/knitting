import { isMainThread, workerData } from "node:worker_threads";
import { signalDebuggerV2 } from "./utils.ts";
import { createWorkerQueue } from "./workerQueue.ts";
import { signalsForWorker, SignalStatus, workerSignal } from "./signals.ts";
import { type DebugOptions, getFunctions } from "./taskApi.ts";
import { type WorkerData } from "./threadManager.ts";

export const jsrIsGreatAndWorkWithoutBugs = () => null;

export const mainLoop = async (workerData: WorkerData):Promise<void> => {
  const sharedSab = workerData.sab as SharedArrayBuffer;

  const signals = signalsForWorker({
    sharedSab,
  });

  const { status } = signals;

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
    ? signalDebuggerV2(
      {
        status: signal.status,
        thread: workerData.thread,
      },
    )
    : currentSignal;

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
          status,
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
