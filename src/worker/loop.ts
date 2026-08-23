import {
  addRuntimeDataListener,
  createRuntimeMessageChannel,
  RUNTIME_IS_MAIN_THREAD,
  RUNTIME_IS_PROCESS_WORKER,
  RUNTIME_PARENT_PORT,
  RUNTIME_WORKER_DATA,
} from "../common/worker-runtime.ts";
import { isSharedBufferSource } from "../common/shared-buffer-region.ts";
import { isLockBufferTextCompat } from "../common/shared-buffer-text.ts";
import { createWorkerRxQueue } from "./rx-queue.ts";
import {
  createSharedMemoryTransport,
  WORKER_STOP,
} from "../ipc/transport/shared-memory.ts";
import { lock2 } from "../memory/lock.ts";
// Side-effect import: registers the payload codec (cycle break for Andromeda;
// see lock.ts). Must run before any lock2() call.
import "../memory/payloadCodec.ts";
import type { LockBuffers, WorkerData } from "../types.ts";
import { getFunctions } from "./task-loader.ts";
import { pauseGeneric, sleepUntilChanged, whilePausing } from "./timers.ts";
import { IS_ANDROMEDA, RUNTIME, SET_IMMEDIATE } from "../common/runtime.ts";
import { getNodeProcess } from "../common/node-compat.ts";
import {
  assertWorkerImportsResolved,
  assertWorkerSharedMemoryBootData,
  installPerformanceNowGuard,
  installTerminationGuard,
  installUnhandledRejectionSilencer,
  scrubWorkerDataSensitiveBuffers,
} from "./safety/index.ts";
import { signalAbortFactory } from "../shared/abortSignal.ts";
import { runWorkerBootstrap } from "./bootstrap.ts";
import {
  getProcessWorkerNativeWaitU32,
  installProcessWorkerBootstrap,
} from "./process-worker-bootstrap.ts";
import {
  readBufferReferenceReturnReleaseMessage,
} from "../connections/buffer-reference.ts";
import { resolveDebugNamespaces } from "../debug/gate.ts";

const WORKER_FATAL_MESSAGE_KEY = "__knittingWorkerFatal";

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
        (getNodeProcess() as
          | ReturnType<typeof getNodeProcess> & {
            exit?: (code?: number) => never;
          }
          | undefined)?.exit?.(1);
      } catch {
      }
    }
  }
};

const installBufferReferenceReleaseListener = (
  releaseReturnedBufferReference: (token: bigint) => void,
): void => {
  const handleMessage = (message: unknown): void => {
    const token = readBufferReferenceReturnReleaseMessage(message);
    if (token !== undefined) releaseReturnedBufferReference(token);
  };

  if (RUNTIME_PARENT_PORT !== undefined) {
    addRuntimeDataListener(RUNTIME_PARENT_PORT, handleMessage);
    return;
  }

  const scope = globalThis as typeof globalThis & {
    addEventListener?: (
      type: string,
      listener: (event: { data?: unknown }) => void,
    ) => void;
  };
  scope.addEventListener?.("message", (event) => {
    handleMessage((event as { data?: unknown })?.data);
  });
};

export const workerMainLoop = async (
  startupData: WorkerData,
): Promise<void> => {
  // Startup-only safety layer: no per-iteration checks in the hot loop.
  installTerminationGuard();
  installUnhandledRejectionSilencer();
  installPerformanceNowGuard();

  const {
    debug,
    sab,
    thread,
    startAt,
    workerOptions,
    lock,
    returnLock,
    abortSignalSAB,
    abortSignalMax,
    payloadConfig,
    bufferReferenceReturn,
    permission,
    notifyOnHostPublish,
    totalNumberOfThread,
    list,
    ids,
    names,
    at,
    steal,
  } = startupData as WorkerData;

  scrubWorkerDataSensitiveBuffers(startupData);
  assertWorkerSharedMemoryBootData({ sab, lock, returnLock });

  const debugNamespaces = resolveDebugNamespaces(debug);
  const dbg = debugNamespaces.size > 0
    ? await import("../debug/handle.ts").then((module) =>
      module.initDebug({
        name: `w${thread}`,
        runtime: RUNTIME,
        namespaces: debugNamespaces,
      })
    )
    : undefined;

  // const object, not `enum`: Andromeda's Nova engine can't parse `enum`.
  const Comment = {
    thisIsAHint: 0,
  } as const;
  const signals = createSharedMemoryTransport({
    sabObject: {
      sharedSab: sab,
    },
    isMain: false,
    thread,
    startTime: startAt,
  });

  const lockState = lock2({
    headers: lock.headers,
    headerSlotStrideU32: lock.headerSlotStrideU32,
    LockBoundSector: lock.lockSector,
    payload: lock.payload,
    payloadSector: lock.payloadSector,
    payloadConfig,
    textCompat: lock.textCompat,
    processBoundary: RUNTIME_IS_PROCESS_WORKER,
    // Under stealing the request region is shared, so decode() becomes a
    // region-Dekker claim against the other endpoints.
    consumers: steal?.consumers,
    consumerId: steal?.consumerId,
    regionLanes: steal?.regionLanes,
  });
  const returnLockState = lock2({
    headers: returnLock.headers,
    headerSlotStrideU32: returnLock.headerSlotStrideU32,
    LockBoundSector: returnLock.lockSector,
    payload: returnLock.payload,
    payloadSector: returnLock.payloadSector,
    payloadConfig,
    textCompat: returnLock.textCompat,
    processBoundary: RUNTIME_IS_PROCESS_WORKER,
    // The host parks on this lock's publication word when it has no work to
    // flush. Request locks are host-produced and must not wake that waiter.
    notifyOnHostPublish,
  });

  const timers = workerOptions?.timers;
  const spinMicroseconds = timers?.spinMicroseconds ??
    Math.max(1, totalNumberOfThread) * 50;
  const parkMs = dbg !== undefined
    ? Number.POSITIVE_INFINITY
    : (timers?.parkMs ??
      Math.max(1, totalNumberOfThread) * 50);

  const pauseSpin = (() => {
    const fn = typeof timers?.pauseNanoseconds === "number"
      ? whilePausing({ pauseInNanoseconds: timers.pauseNanoseconds })
      : pauseGeneric;
    return () => fn(); // always a closure wrapper
  })();

  const { opView, rxStatus, txStatus, stopView } = signals;
  const a_store = Atomics.store;
  const a_load = Atomics.load;
  const nativeWaitU32 = getProcessWorkerNativeWaitU32();

  await runWorkerBootstrap({
    bootstrap: workerOptions?.bootstrap,
    thread,
    totalNumberOfThread,
  });
  dbg?.envPhase("bootstrap");

  const listOfFunctions = await getFunctions({
    list,
    isWorker: true,
    ids,
    names,
    at,
    permission,
  });
  dbg?.envPhase("tasks");
  dbg?.log(
    "imports",
    `${listOfFunctions.length} task(s) from ${
      list.map((spec) => spec.split(/[\\/]/).pop() || spec).join(", ")
    }`,
  );
  assertWorkerImportsResolved({ list, ids, names, listOfFunctions });
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
    drainReturnReleases,
    releaseReturnedBufferReference,
  } = createWorkerRxQueue({
    listOfFunctions,
    workerOptions,
    lock: lockState,
    returnLock: returnLockState,
    borrowReturnedBufferReferences: bufferReferenceReturn === "borrow",
    hasAborted: abortSignals?.hasAborted,
    stealing: steal !== undefined,
  });
  installBufferReferenceReleaseListener(releaseReturnedBufferReference);

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
    flushBeforeClaim: steal !== undefined,
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

  let wakeToken = a_load(opView, 0);

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

  const traceSignals = dbg?.enabled("signals") === true;
  const _hasCompleted = hasCompleted;
  const _hasPending = hasPending;
  const _getAwaiting = getAwaiting;
  const _drainReturnReleases = drainReturnReleases;
  const _pauseSpin = pauseSpin;
  const _enqueueLock = traceSignals
    ? (): boolean => {
      const progressed = enqueueLock();
      if (progressed) {
        dbg!.log("signals", "work from=host");
      }
      return progressed;
    }
    : enqueueLock;
  const _writeBatch = traceSignals
    ? (max: number): number => {
      const wrote = writeBatch(max);
      if (wrote > 0) dbg!.log("signals", `result count=${wrote}`);
      return wrote;
    }
    : writeBatch;
  const _serviceBatchImmediate = traceSignals
    ? (): number => {
      const ran = serviceBatchImmediate();
      if (ran > 0) dbg!.log("signals", `run count=${ran}`);
      return ran;
    }
    : serviceBatchImmediate;
  const _pauseUntil = traceSignals
    ? (value: number, spinMicroseconds: number, parkMs?: number): void => {
      dbg!.log("signals", `idle token=${value}`);
      pauseUntil(value, spinMicroseconds, parkMs);
    }
    : pauseUntil;

  const flushBeforeClaim = steal !== undefined;

  /** Leave the dispatch loop and acknowledge shutdown. */
  const stopLoop = () => {
    a_store(stopView, 0, WORKER_STOP.acknowledged);
    a_store(rxStatus, 0, 0);
    try {
      port1.close?.();
      port2.close?.();
    } catch {}
  };

  const loop = () => {
    isInMacro = false;
    let progressed = true;
    let awaiting = 0;
    while (true) {
      if (stopView[0] !== WORKER_STOP.running) return stopLoop();

      if (flushBeforeClaim) {
        // Stealing only. Flush finished work before taking more on: a computed
        // response should not wait behind a claim, and that claim can block on
        // a peer withdrawing its intent. Measured to hurt the per-lane path,
        // where a claim is a cheap private decode and picking work up promptly
        // matters more, so the classic order is kept below.
        // Reordering must not make `progressed` sticky: it answers "did this
        // iteration move anything", so it has to start false every pass or the
        // park below is unreachable and the worker spins a core forever.
        progressed = false;
        if (_hasCompleted()) {
          if (_writeBatch(WRITE_MAX) > 0) progressed = true;
        }
        progressed = _enqueueLock() || progressed;
      } else {
        progressed = _enqueueLock();

        if (_hasCompleted()) {
          if (_writeBatch(WRITE_MAX) > 0) progressed = true;
        }
      }

      _drainReturnReleases();

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
        _pauseUntil(wakeToken, spinMicroseconds, parkMs);
        wakeToken = a_load(opView, 0);
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
  dbg?.log(
    "lifecycle",
    `ready: ${listOfFunctions.length} task(s) on thread ${thread}/${totalNumberOfThread}, entering dispatch loop`,
  );
  scheduleMacro();
};

const isWorkerGlobalScope = (): boolean => {
  const scopeCtor =
    (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope;
  if (typeof scopeCtor === "function") {
    try {
      if (
        globalThis instanceof (scopeCtor as new (...args: unknown[]) => object)
      ) {
        return true;
      }
    } catch {
      // fall through to runtime-specific checks
    }
  }
  // Andromeda has no `WorkerGlobalScope`; its worker scope carries a `self`
  // global that the main thread lacks.
  if (
    IS_ANDROMEDA &&
    typeof (globalThis as { self?: unknown }).self !== "undefined"
  ) {
    return true;
  }
  return false;
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
    Array.isArray(candidate.names) &&
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

if (
  RUNTIME_IS_MAIN_THREAD === false &&
  isWorkerBootPayload(RUNTIME_WORKER_DATA)
) {
  void workerMainLoop(RUNTIME_WORKER_DATA).catch(reportWorkerStartupFatal);
} else if (RUNTIME_IS_PROCESS_WORKER) {
  installProcessWorkerBootstrap({
    isWorkerBootPayload,
    reportWorkerStartupFatal,
    startWorker: (data) => {
      void workerMainLoop(data).catch(reportWorkerStartupFatal);
    },
  });
} else if (isWorkerGlobalScope()) {
  installWorkerGlobalBootstrap();
}
