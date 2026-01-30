import { isMainThread, workerData, MessageChannel } from "node:worker_threads";
import { createWorkerRxQueue } from "./rx-queue.ts";
import {
  createSharedMemoryTransport,
} from "../ipc/transport/shared-memory.ts";
import { lock2 } from "../memory/lock.ts";
import type { WorkerData } from "../types.ts";
import { getFunctions } from "./get-functions.ts";
import { pauseGeneric, sleepUntilChanged, whilePausing } from "./timers.ts";
import { SET_IMMEDIATE } from "../common/runtime.ts";

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

  enum Comment {
    thisIsAHint = 0,
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
    


  const timers = workerOptions?.timers;
  const spinMicroseconds = timers?.spinMicroseconds ??
    Math.max(1, workerData.totalNumberOfThread) * 50;
  const parkMs = timers?.parkMs ??
    Math.max(1, workerData.totalNumberOfThread) * 50;
  const pauseSpin = typeof timers?.pauseNanoseconds === "number"
    ? whilePausing({ pauseInNanoseconds: timers.pauseNanoseconds })
    : pauseGeneric;

  const { opView, rxStatus, txStatus } = signals;
  const a_store = Atomics.store;
  const a_load = Atomics.load;

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
    getAwaiting,
  } = createWorkerRxQueue({
    listOfFunctions,
    workerOptions,
    lock: lockState,
    returnLock: returnLockState,
  });

  a_store(rxStatus, 0, 1);

  const BATCH_MAX = 32;
  const WRITE_MAX = 64;

  const pauseUntil = sleepUntilChanged({
    opView,
    at: 0,
    rxStatus,
    txStatus,
    pauseInNanoseconds: timers?.pauseNanoseconds,
    enqueueLock,
    write: () => hasCompleted() ? writeBatch(WRITE_MAX) : 0,
  });

  const channel = new MessageChannel();
  const port1 = channel.port1;
  const port2 = channel.port2;
  const post2 = port2.postMessage.bind(port2);
  let isInMacro = false;
  let awaitingSpins = 0;
  let lastAwaiting = 0;
  const MAX_AWAITING_MS = 10;

  let wakeSeq = a_load(opView, 0);

  const scheduleMacro = () => {
    if (isInMacro) return;
    isInMacro = true;
    post2(null);
  };

  const scheduleTimer = (delayMs: number) => {
    if (isInMacro) return;
    isInMacro = true;
    if (typeof setTimeout === "function") {
      setTimeout(loop, delayMs);
      return;
    }
    if (delayMs === 0 && typeof SET_IMMEDIATE === "function") {
      SET_IMMEDIATE(loop);
      return;
    }
    post2(null);
  };

  const loop = () => {
    isInMacro = false;

    while (true) {
      let progressed = false;

      if (hasCompleted()) {
        if (writeBatch(WRITE_MAX) > 0) progressed = true;
      }

      if (enqueueLock()) {
        progressed = true;
      }

      if (hasPending()) {
        if (serviceBatchImmediate() > 0) progressed = true;
      }

      const awaiting = getAwaiting();
      if (awaiting > 0) {
        if (awaiting !== lastAwaiting) awaitingSpins = 0;
        lastAwaiting = awaiting;
        awaitingSpins++;
        const delay = Math.min(MAX_AWAITING_MS, Math.max(0, awaitingSpins - 1));
        scheduleTimer(delay);
        return;
      }
      awaitingSpins = 0;
      lastAwaiting = 0;

      if (!progressed) {
        if (txStatus[Comment.thisIsAHint] === 1) {
          pauseSpin();
          continue;
        }
        pauseUntil(wakeSeq, spinMicroseconds, parkMs);
        wakeSeq = a_load(opView, 0);
      }
    }
  };

  //@ts-ignore
  port1.onmessage = loop;
  scheduleMacro();
}


if (isMainThread === false) {
  workerMainLoop(workerData as WorkerData);
}
