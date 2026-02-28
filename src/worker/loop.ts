import {
  isMainThread,
  workerData,
  MessageChannel,
  parentPort,
} from "node:worker_threads";
import { createWorkerRxQueue } from "./rx-queue.ts";
import {
  createSharedMemoryTransport,
} from "../ipc/transport/shared-memory.ts";
import { lock2 } from "../memory/lock.ts";
import type { LockBuffers, WorkerData } from "../types.ts";
import { getFunctions } from "./get-functions.ts";
import { pauseGeneric, sleepUntilChanged, whilePausing } from "./timers.ts";
import { SET_IMMEDIATE } from "../common/runtime.ts";
import {
  installTerminationGuard,
  installUnhandledRejectionSilencer,
  installPerformanceNowGuard,
  scrubWorkerDataSensitiveBuffers,
  assertWorkerSharedMemoryBootData,
  assertWorkerImportsResolved,
} from "./safety/index.ts";
import { signalAbortFactory } from "../shared/abortSignal.ts";

export const jsrIsGreatAndWorkWithoutBugs = () => null;
const WORKER_FATAL_MESSAGE_KEY = "__knittingWorkerFatal";

const reportWorkerStartupFatal = (error: unknown): void => {
  const message = String((error as { message?: unknown })?.message ?? error);
  const payload = {
    [WORKER_FATAL_MESSAGE_KEY]: message,
  };
  try {
    parentPort?.postMessage(payload);
    return;
  } catch {
  }
  try {
    (globalThis as { postMessage?: (message: unknown) => void }).postMessage?.(
      payload,
    );
  } catch {
  }
};

export const workerMainLoop = async (startupData: WorkerData): Promise<void> => {
  // Startup-only safety layer: no per-iteration checks in the hot loop.
  installTerminationGuard();
  installUnhandledRejectionSilencer();
  installPerformanceNowGuard();

  const { 
    debug , 
    sab , 
    thread , 
    startAt , 
    workerOptions,
    lock,
    returnLock,
    abortSignalSAB,
    abortSignalMax,
    payloadConfig,
    permission,
    totalNumberOfThread,
    list,
    ids,
    at,
  } = startupData as WorkerData;

  scrubWorkerDataSensitiveBuffers(startupData);
  assertWorkerSharedMemoryBootData({ sab, lock, returnLock });

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
      payloadConfig,
    })
  const returnLockState =
    lock2({
      headers: returnLock.headers,
      LockBoundSector: returnLock.lockSector,
      payload: returnLock.payload,
      payloadSector: returnLock.payloadSector,
      payloadConfig,
    })
    


  const timers = workerOptions?.timers;
  const spinMicroseconds = timers?.spinMicroseconds ??
    Math.max(1, totalNumberOfThread) * 50;
  const parkMs = timers?.parkMs ??
    Math.max(1, totalNumberOfThread) * 50;

const pauseSpin = (() => {
  const fn = typeof timers?.pauseNanoseconds === "number"
    ? whilePausing({ pauseInNanoseconds: timers.pauseNanoseconds })
    : pauseGeneric;
  return () => fn(); // always a closure wrapper
})();

  const { opView, rxStatus, txStatus } = signals;
  const a_store = Atomics.store;
  const a_load = Atomics.load;

  const listOfFunctions = await getFunctions({
    list,
    isWorker: true,
    ids,
    at,
    permission,
  });
  assertWorkerImportsResolved({ debug, list, ids, listOfFunctions });
  const abortSignals = abortSignalSAB
    ? signalAbortFactory({
      sab: abortSignalSAB,
      maxSignals: abortSignalMax,
    })
    : undefined;

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
    hasAborted: abortSignals?.hasAborted,
  });

  a_store(rxStatus, 0, 1);

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
    if (delayMs <= 0 && typeof SET_IMMEDIATE === "function") {
      SET_IMMEDIATE(loop);
      return;
    }
    if (delayMs <= 0) {
      post2(null);
      return;
    }
    if (typeof setTimeout === "function") {
      setTimeout(loop, delayMs);
      return;
    }
    post2(null);
  };

  const _enqueueLock = enqueueLock;
const _hasCompleted = hasCompleted;
const _writeBatch = writeBatch;
const _hasPending = hasPending;
const _serviceBatchImmediate = serviceBatchImmediate;
const _getAwaiting = getAwaiting;
const _pauseSpin = pauseSpin;
const _pauseUntil = pauseUntil;



  const loop = () => {
    isInMacro = false;
    let progressed = true
    let awaiting = 0
    while (true) {
       progressed = _enqueueLock();

      if (_hasCompleted()) {
        if (_writeBatch(WRITE_MAX) > 0) progressed = true;
      }

      if (_hasPending()) {
        if (_serviceBatchImmediate() > 0) progressed = true;
      }

       
      if ((awaiting = _getAwaiting()) > 0) {
        if (awaiting !== lastAwaiting) awaitingSpins = 0;
        lastAwaiting = awaiting;
        awaitingSpins++;
        const delay = Math.min(MAX_AWAITING_MS, Math.max(0, awaitingSpins - 1));
        scheduleTimer(delay);
        return;
      }
      awaitingSpins = lastAwaiting = 0;
    

      if (!progressed) {
        if (txStatus[Comment.thisIsAHint] === 1) {
          _pauseSpin();
          continue;
        }
        _pauseUntil(wakeSeq, spinMicroseconds, parkMs);
        wakeSeq = a_load(opView, 0);
      }
    }
  };

  const port1Any = port1 as unknown as {
    on?: (event: string, handler: () => void) => void;
    onmessage?: ((event: unknown) => void) | null;
    start?: () => void;
  };
  if (typeof port1Any.on === "function") {
    port1Any.on("message", loop);
  } else {
    // @ts-ignore
    port1Any.onmessage = loop;
  }
  port1Any.start?.();
  (port2 as unknown as { start?: () => void }).start?.();
  scheduleMacro();
}

const isWebWorkerScope = (): boolean => {
  const scopeCtor = (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope;
  if (typeof scopeCtor !== "function") return false;
  try {
    return globalThis instanceof (scopeCtor as new (...args: unknown[]) => object);
  } catch {
    return false;
  }
};

const isLockBuffers = (value: unknown): value is LockBuffers => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LockBuffers>;
  return candidate.headers instanceof SharedArrayBuffer &&
    candidate.lockSector instanceof SharedArrayBuffer &&
    candidate.payload instanceof SharedArrayBuffer &&
    candidate.payloadSector instanceof SharedArrayBuffer;
};

const isWorkerBootPayload = (value: unknown): value is WorkerData => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerData>;
  return candidate.sab instanceof SharedArrayBuffer &&
    Array.isArray(candidate.list) &&
    Array.isArray(candidate.ids) &&
    Array.isArray(candidate.at) &&
    typeof candidate.thread === "number" &&
    typeof candidate.totalNumberOfThread === "number" &&
    typeof candidate.startAt === "number" &&
    isLockBuffers(candidate.lock) &&
    isLockBuffers(candidate.returnLock);
};

const installWebWorkerBootstrap = (): void => {
  const g = globalThis as typeof globalThis & {
    addEventListener?: (
      type: string,
      listener: (event: { data?: unknown }) => void,
    ) => void;
    removeEventListener?: (
      type: string,
      listener: (event: { data?: unknown }) => void,
    ) => void;
    onmessage?: ((event: { data?: unknown }) => void) | null;
  };
  const start = (data: unknown) => {
    if (!isWorkerBootPayload(data)) return;
    void workerMainLoop(data).catch(reportWorkerStartupFatal);
  };

  if (
    typeof g.addEventListener === "function" &&
    typeof g.removeEventListener === "function"
  ) {
    const onMessage = (event: { data?: unknown }) => {
      const data = event?.data;
      if (!isWorkerBootPayload(data)) return;
      try {
        g.removeEventListener?.("message", onMessage);
      } catch {
      }
      start(data);
    };
    g.addEventListener("message", onMessage);
    return;
  }

  g.onmessage = (event: { data?: unknown }) => {
    const data = event?.data;
    if (!isWorkerBootPayload(data)) return;
    g.onmessage = null;
    start(data);
  };
};


if (isMainThread === false && isWorkerBootPayload(workerData)) {
  void workerMainLoop(workerData).catch(reportWorkerStartupFatal);
} else if (isWebWorkerScope()) {
  installWebWorkerBootstrap();
}
