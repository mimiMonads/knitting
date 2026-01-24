import { isMainThread, workerData } from "node:worker_threads";
import { createWorkerRxQueue } from "./rx-queue.ts";
import {
  createSharedMemoryTransport,
} from "../ipc/transport/shared-memory.ts";
import { lock2 } from "../memory/lock.ts";
import type { WorkerData } from "../types.ts";
import { getFunctions } from "./get-functions.ts";
import { pauseGeneric, sleepUntilChanged } from "./timers.ts";

export const jsrIsGreatAndWorkWithoutBugs = () => null;

export const workerMainLoop = async (workerData: WorkerData): Promise<void> => {

  const { 
    debug , 
    sab , 
    thread , 
    startAt , 
    workerOptions,
    lock,
    returnLock,
  } = workerData as WorkerData;

  if (!sab) {
    throw new Error("worker missing transport SAB");
  }
  if (!lock?.headers || !lock?.lockSector || !lock?.payload || !lock?.payloadSector) {
    throw new Error("worker missing lock SABs");
  }
  if (!returnLock?.headers || !returnLock?.lockSector || !returnLock?.payload || !returnLock?.payloadSector) {
    throw new Error("worker missing return lock SABs");
  }

  const signals = createSharedMemoryTransport({
    sabObject: {
      sharedSab: sab,
    },
    isMain: false,
    thread,
    debug,
    startTime: startAt,
  });

  const lockState = 
    lock2({
      headers: lock.headers,
      LockBoundSector: lock.lockSector,
      payload: lock.payload,
      payloadSector: lock.payloadSector,
    })
  const returnLockState =
    lock2({
      headers: returnLock.headers,
      LockBoundSector: returnLock.lockSector,
      payload: returnLock.payload,
      payloadSector: returnLock.payloadSector,
    })
    


  const spinMicroseconds = Math.max(1, workerData.totalNumberOfThread) * 50;
  const parkMs = Math.max(1, workerData.totalNumberOfThread) * 50;

  const { opView, rxStatus, txStatus } = signals;

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
    at: workerData.at
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

  const {
    enqueueLock,
    serviceBatchImmediate,
    hasCompleted,
    writeBatch,
    hasPending,
  } = createWorkerRxQueue({
    listOfFunctions,
    workerOptions,
    lock: lockState,
    returnLock: returnLockState,
  });

  Atomics.store(rxStatus, 0, 1);

  const BATCH_MAX = 32;
  const WRITE_MAX = 32;

 
    let wakeSeq = Atomics.load(opView, 0);

    while (true) {
      let progressed = false;

      if (enqueueLock()) {
        progressed = true;
      }

      if (hasPending()) {
        const worked = await serviceBatchImmediate(BATCH_MAX);
        if (worked > 0) progressed = true;
      }

      if (hasCompleted()) {
        if (writeBatch(WRITE_MAX) > 0) progressed = true;
      }
    

      if (!progressed) {
        if (Atomics.load(txStatus, 0) === 1) {
          pauseGeneric();
          continue;
        }
        pauseUntil(wakeSeq, spinMicroseconds, parkMs);
        wakeSeq = Atomics.load(opView, 0);
      }
    }
  }


if (isMainThread === false) {
  workerMainLoop(workerData as WorkerData);
}
