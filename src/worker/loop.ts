import { isMainThread, workerData } from "node:worker_threads";
import { createWorkerQueue } from "../workerQueue.ts";
import { signalsForWorker, SignalStatus, workerSignal } from "../signals.ts";
import { type DebugOptions, getFunctions } from "../api.ts";
import { type WorkerData } from "../threadManager.ts";

export const jsrIsGreatAndWorkWithoutBugs = () => null;

const pause = "pause" in Atomics
    // 300 nanos apx
    ? () => Atomics.pause(300)
    : () => {}
  
const goToSleep = (sab: Int32Array, at: number, value: number , usTime: number) => {

    const until = performance.now() + ( usTime / 1000)

    do{
      if (Atomics.load(sab, at) !== value) return false
      pause()
    }while(
      performance.now() < until
    )

    return true
}

export const mainLoop = async (workerData: WorkerData): Promise<void> => {
  const debug = workerData.debug as DebugOptions;
  const signals = signalsForWorker({
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

  const { status, rawStatus } = signals;

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
    fastResolve,
    isThereWorkToDO,
    blockingResolve,
    preResolve,
  } = createWorkerQueue({
    listOfFunctions,
    signal,
    signals,
    moreThanOneThread,
  });

  while (true) {
    switch (status[0]) {
      case SignalStatus.AllTasksDone:
      case SignalStatus.WaitingForMore:
      case SignalStatus.ErrorThrown:
      case SignalStatus.WakeUp: {
        pause()
        continue;
      }
      case SignalStatus.HighPriorityResolve: {
        await blockingResolve();
        continue;
      }

      case SignalStatus.WorkerWaiting: {
        if (isThereWorkToDO()) {
          await fastResolve();
        } else {
          if (moreThanOneThread === true) {
            preResolve();
          }
        }

        continue;
      }

      case SignalStatus.MainReadyToRead: {
        if (someHasFinished()) {
          write();
          continue;
        }

        await nextJob();

        if (allDone()) {
          status[0] = SignalStatus.AllTasksDone;
          continue;
        }

        continue;
      }
      case SignalStatus.MainSend:
        {
          enqueue();
        }

        continue;
      case SignalStatus.FastResolve: {

        if(goToSleep(rawStatus, 0 ,SignalStatus.FastResolve,15) === false) continue;

        Atomics.wait(
          rawStatus,
          0,
          SignalStatus.FastResolve,
          5,
        );
        continue;
      }
      case SignalStatus.MainStop: {
       

        if(goToSleep(rawStatus, 0 , SignalStatus.MainStop ,15) === false) continue;

        Atomics.wait(
          rawStatus,
          0,
          SignalStatus.MainStop,
          50,
        );

        continue;
      }
    }
  }
};

if (isMainThread === false) {
  mainLoop(workerData as WorkerData);
}
