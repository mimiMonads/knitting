import {
  RUNTIME_IS_MAIN_THREAD,
  RUNTIME_IS_PROCESS_WORKER,
  RUNTIME_PARENT_PORT,
  RUNTIME_PROCESS_WORKER_BOOT_ENV,
  RUNTIME_PROCESS_WORKER_BOOT_VERSION,
  RUNTIME_WORKER_DATA,
  createRuntimeMessageChannel,
} from "../common/worker-runtime.ts";
import {
  isSharedBufferSource,
  type SharedBufferSource,
} from "../common/shared-buffer-region.ts";
import { isLockBufferTextCompat } from "../common/shared-buffer-text.ts";
import { createWorkerRxQueue } from "./rx-queue.ts";
import {
  createSharedMemoryTransport,
} from "../ipc/transport/shared-memory.ts";
import { lock2 } from "../memory/lock.ts";
import type { LockBuffers, WorkerData } from "../types.ts";
import { getFunctions } from "./get-functions.ts";
import {
  pauseGeneric,
  sleepUntilChanged,
  whilePausing,
  type NativeWaitU32,
} from "./timers.ts";
import { RUNTIME, SET_IMMEDIATE } from "../common/runtime.ts";
import { getNodeProcess } from "../common/node-compat.ts";
import {
  getDefaultProcessSharedBufferPrimitives,
  ProcessSharedBuffer,
  setDefaultProcessSharedBufferPrimitives,
  type ProcessSharedBufferMetadata,
  type ProcessSharedBufferPrimitives,
} from "../connections/process-shared-buffer.ts";
import { createBunConnectionPrimitives } from "../connections/bun.ts";
import { createDenoConnectionPrimitives } from "../connections/deno.ts";
import { loadNodeFutexAddon } from "../connections/node.ts";
import type { SharedMemoryMapping } from "../connections/types.ts";
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

const getProcessWorkerNativeWaitU32 = (): NativeWaitU32 | undefined => {
  if (!RUNTIME_IS_PROCESS_WORKER || RUNTIME !== "node") return undefined;

  try {
    return loadNodeFutexAddon().waitU32;
  } catch {
    return undefined;
  }
};

const reportWorkerStartupFatal = (error: unknown): void => {
  const message = String((error as { message?: unknown })?.message ?? error);
  const payload = {
    [WORKER_FATAL_MESSAGE_KEY]: message,
  };
  let reported = false;
  try {
    RUNTIME_PARENT_PORT?.postMessage?.(payload);
    reported = RUNTIME_PARENT_PORT !== undefined;
  } catch {
  }
  if (!reported) {
    try {
      (globalThis as { postMessage?: (message: unknown) => void }).postMessage!(
        payload,
      );
      reported = true;
    } catch {
    }
  }
  if (!reported) {
    try {
      console.error(`Worker startup failed: ${message}`);
    } catch {
    }
    if (RUNTIME_IS_PROCESS_WORKER) {
      try {
        (getNodeProcess() as ReturnType<typeof getNodeProcess> & {
          exit?: (code?: number) => never;
        } | undefined)?.exit?.(1);
      } catch {
      }
    }
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
      headerSlotStrideU32: lock.headerSlotStrideU32,
    LockBoundSector: lock.lockSector,
    payload: lock.payload,
    payloadSector: lock.payloadSector,
    payloadConfig,
    textCompat: lock.textCompat,
    })
  const returnLockState =
    lock2({
      headers: returnLock.headers,
      headerSlotStrideU32: returnLock.headerSlotStrideU32,
      LockBoundSector: returnLock.lockSector,
      payload: returnLock.payload,
      payloadSector: returnLock.payloadSector,
      payloadConfig,
      textCompat: returnLock.textCompat,
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
  const nativeWaitU32 = getProcessWorkerNativeWaitU32();

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
    nativeWaitU32,
    useSharedMemoryWait: !(
      RUNTIME_IS_PROCESS_WORKER &&
      RUNTIME === "node" &&
      nativeWaitU32 === undefined
    ),
  });

  const channel = createRuntimeMessageChannel();
  const port1 = channel.port1;
  const port2 = channel.port2;
  const post2 = (message: unknown) => port2.postMessage(message);
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

const isWorkerGlobalScope = (): boolean => {
  const scopeCtor =
    (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope;
  if (typeof scopeCtor !== "function") return false;
  try {
    return globalThis instanceof
      (scopeCtor as new (...args: unknown[]) => object);
  } catch {
    return false;
  }
};

const isLockBuffers = (value: unknown): value is LockBuffers => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LockBuffers>;
  return isSharedBufferSource(candidate.headers) &&
    isSharedBufferSource(candidate.lockSector) &&
    isSharedBufferSource(candidate.payload) &&
    isSharedBufferSource(candidate.payloadSector) &&
    (
      candidate.textCompat === undefined ||
      isLockBufferTextCompat(candidate.textCompat)
    );
};

const isWorkerBootPayload = (value: unknown): value is WorkerData => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerData>;
  return isSharedBufferSource(candidate.sab) &&
    Array.isArray(candidate.list) &&
    Array.isArray(candidate.ids) &&
    Array.isArray(candidate.at) &&
    typeof candidate.thread === "number" &&
    typeof candidate.totalNumberOfThread === "number" &&
    typeof candidate.startAt === "number" &&
    (
      candidate.abortSignalSAB === undefined ||
      isSharedBufferSource(candidate.abortSignalSAB)
    ) &&
    isLockBuffers(candidate.lock) &&
    isLockBuffers(candidate.returnLock);
};

const installWorkerGlobalBootstrap = (): void => {
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

type ProcessWorkerWireLockBuffers = Omit<
  LockBuffers,
  "headers" | "lockSector" | "payload" | "payloadSector"
> & {
  headers: ProcessSharedBufferMetadata;
  lockSector: ProcessSharedBufferMetadata;
  payload: ProcessSharedBufferMetadata;
  payloadSector: ProcessSharedBufferMetadata;
};

type ProcessWorkerWireData = Omit<
  WorkerData,
  "sab" | "abortSignalSAB" | "lock" | "returnLock"
> & {
  sab: ProcessSharedBufferMetadata;
  abortSignalSAB?: ProcessSharedBufferMetadata;
  lock: ProcessWorkerWireLockBuffers;
  returnLock: ProcessWorkerWireLockBuffers;
};

type ProcessWorkerBootPayload = {
  version: typeof RUNTIME_PROCESS_WORKER_BOOT_VERSION;
  workerData: ProcessWorkerWireData;
};

type ProcessLikeWithIpc = NonNullable<ReturnType<typeof getNodeProcess>> & {
  off?: (event: string, handler: (...args: unknown[]) => void) => unknown;
  removeListener?: (
    event: string,
    handler: (...args: unknown[]) => void,
  ) => unknown;
};

const isProcessSharedBufferMetadata = (
  value: unknown,
): value is ProcessSharedBufferMetadata => {
  try {
    ProcessSharedBuffer.fromMetadata(value);
    return true;
  } catch {
    return false;
  }
};

const isProcessWorkerWireLockBuffers = (
  value: unknown,
): value is ProcessWorkerWireLockBuffers => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProcessWorkerWireLockBuffers>;
  return isProcessSharedBufferMetadata(candidate.headers) &&
    isProcessSharedBufferMetadata(candidate.lockSector) &&
    isProcessSharedBufferMetadata(candidate.payload) &&
    isProcessSharedBufferMetadata(candidate.payloadSector) &&
    (
      candidate.textCompat === undefined ||
      isLockBufferTextCompat(candidate.textCompat)
    );
};

const isProcessWorkerBootPayload = (
  value: unknown,
): value is ProcessWorkerBootPayload => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProcessWorkerBootPayload>;
  const workerData = candidate.workerData as Partial<ProcessWorkerWireData> |
    undefined;
  return candidate.version === RUNTIME_PROCESS_WORKER_BOOT_VERSION &&
    !!workerData &&
    isProcessSharedBufferMetadata(workerData.sab) &&
    Array.isArray(workerData.list) &&
    Array.isArray(workerData.ids) &&
    Array.isArray(workerData.at) &&
    typeof workerData.thread === "number" &&
    typeof workerData.totalNumberOfThread === "number" &&
    typeof workerData.startAt === "number" &&
    (
      workerData.abortSignalSAB === undefined ||
      isProcessSharedBufferMetadata(workerData.abortSignalSAB)
    ) &&
    isProcessWorkerWireLockBuffers(workerData.lock) &&
    isProcessWorkerWireLockBuffers(workerData.returnLock);
};

const getProcessWorkerPrimitives = (): ProcessSharedBufferPrimitives => {
  const primitives = RUNTIME === "bun"
    ? createBunConnectionPrimitives()
    : RUNTIME === "deno"
    ? createDenoConnectionPrimitives()
    : getDefaultProcessSharedBufferPrimitives();
  setDefaultProcessSharedBufferPrimitives(primitives);
  return primitives;
};

const reviveProcessWorkerData = (
  wire: ProcessWorkerWireData,
): WorkerData => {
  const primitives = getProcessWorkerPrimitives();
  const mappings = new Map<string, SharedMemoryMapping>();
  const reviveRegion = (
    metadata: ProcessSharedBufferMetadata,
  ): SharedBufferSource => {
    const processBuffer = ProcessSharedBuffer.fromMetadata(metadata);
    const descriptor = processBuffer.descriptor;
    const key = `${descriptor.fd}:${descriptor.size}:${descriptor.runtime ?? ""}`;
    let mapping = mappings.get(key);
    if (mapping === undefined) {
      mapping = descriptor.map(primitives);
      mappings.set(key, mapping);
    } else {
      descriptor.attach(mapping);
    }

    return {
      sab: mapping.buffer,
      byteOffset: processBuffer.byteOffset,
      byteLength: processBuffer.byteLength,
    };
  };
  const reviveLockBuffers = (
    lock: ProcessWorkerWireLockBuffers,
  ): LockBuffers => ({
    ...lock,
    headers: reviveRegion(lock.headers),
    lockSector: reviveRegion(lock.lockSector),
    payload: reviveRegion(lock.payload),
    payloadSector: reviveRegion(lock.payloadSector),
  });

  return {
    ...wire,
    sab: reviveRegion(wire.sab),
    abortSignalSAB: wire.abortSignalSAB === undefined
      ? undefined
      : reviveRegion(wire.abortSignalSAB),
    lock: reviveLockBuffers(wire.lock),
    returnLock: reviveLockBuffers(wire.returnLock),
  };
};

const installProcessWorkerBootstrap = (): void => {
  const processLike = getNodeProcess() as ProcessLikeWithIpc | undefined;

  const start = (payload: ProcessWorkerBootPayload) => {
    const data = reviveProcessWorkerData(payload.workerData);
    if (!isWorkerBootPayload(data)) {
      throw new TypeError("invalid process worker boot payload");
    }
    void workerMainLoop(data).catch(reportWorkerStartupFatal);
  };
  const envBoot = processLike?.env?.[RUNTIME_PROCESS_WORKER_BOOT_ENV];
  if (typeof envBoot === "string" && envBoot.length > 0) {
    try {
      const payload = JSON.parse(envBoot);
      if (!isProcessWorkerBootPayload(payload)) {
        throw new TypeError("invalid process worker boot payload");
      }
      try {
        delete processLike?.env?.[RUNTIME_PROCESS_WORKER_BOOT_ENV];
      } catch {
      }
      start(payload);
    } catch (error) {
      reportWorkerStartupFatal(error);
    }
    return;
  }

  if (typeof processLike?.on !== "function") return;

  const onMessage = (message: unknown) => {
    if (!isProcessWorkerBootPayload(message)) return;
    try {
      processLike.off?.("message", onMessage);
      processLike.removeListener?.("message", onMessage);
    } catch {
    }
    try {
      start(message);
    } catch (error) {
      reportWorkerStartupFatal(error);
    }
  };

  processLike.on("message", onMessage);
};


if (
  RUNTIME_IS_MAIN_THREAD === false &&
  isWorkerBootPayload(RUNTIME_WORKER_DATA)
) {
  void workerMainLoop(RUNTIME_WORKER_DATA).catch(reportWorkerStartupFatal);
} else if (RUNTIME_IS_PROCESS_WORKER) {
  installProcessWorkerBootstrap();
} else if (isWorkerGlobalScope()) {
  installWorkerGlobalBootstrap();
}
