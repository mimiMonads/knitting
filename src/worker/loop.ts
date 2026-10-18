import {
  createRuntimeMessageChannel,
  PROCESS_COMPLETION_DOORBELL,
  PROCESS_WORKER_WAKE,
  PROCESS_WORKER_ASYNC_ACTIVE,
  PROCESS_WORKER_ASYNC_IDLE,
  PROCESS_WORKER_ASYNC_BLOCKED,
  RUNTIME_IS_MAIN_THREAD,
  RUNTIME_IS_PROCESS_WORKER,
  RUNTIME_PARENT_PORT,
  RUNTIME_WORKER_DATA,
} from "../common/worker-runtime.ts";
import { isSharedBufferSource } from "../common/shared-buffer-region.ts";
import { isLockBufferTextCompat } from "../common/shared-buffer-text.ts";
import { createDenoCompletionNotifier } from "../runtime/deno-doorbell.ts";
import { createNodeCompletionNotifier } from "../runtime/node-doorbell.ts";
import { createWorkerRxQueue } from "./rx-queue.ts";
import { createUnravelController, createUnravelShared } from "./unravel.ts";
import { createUnravelOwnership } from "./unravel-ownership.ts";
import { installSharedReturn } from "./shared-return.ts";
import {
  createSharedMemoryTransport,
  WORKER_STOP,
} from "../ipc/transport/shared-memory.ts";
import { lock2 } from "../memory/lock.ts";
// Registers the payload codec before any lock is built.
import "../memory/payloadCodec.ts";
import type { LockBuffers, WorkerData } from "../types.ts";
import { getFunctions } from "./task-loader.ts";
import {
  IS_BUN_WINDOWS,
  pauseGeneric,
  sleepUntilChanged,
  whilePausing,
} from "./timers.ts";
import { IS_ANDROMEDA, RUNTIME, SET_IMMEDIATE } from "../common/runtime.ts";
import { getNodeProcess } from "../common/node-compat.ts";
import {
  assertWorkerImportsResolved,
  assertWorkerSharedMemoryBootData,
  installPerformanceNowGuard,
  installTerminationGuard,
  installUnhandledRejectionSilencer,
  reportSilencedRejections,
  scrubWorkerDataSensitiveBuffers,
} from "./safety/index.ts";
import { signalAbortFactory } from "../shared/abortSignal.ts";
import { runWorkerBootstrap } from "./bootstrap.ts";
import {
  getProcessWorkerNativeWaitU32,
  installProcessWorkerBootstrap,
} from "./process-worker-bootstrap.ts";
import { resolveDebugNamespaces } from "../debug/gate.ts";

const WORKER_FATAL_MESSAGE_KEY = "__knittingWorkerFatal";
// Park timeout while finished results wait for return slots (see the loop).
const BLOCKED_RETURN_PARK_MS = 1;

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

export const workerMainLoop = async (
  startupData: WorkerData,
): Promise<void> => {
  // Startup-only safety layer: no per-iteration checks in the hot loop.
  installTerminationGuard();
  installUnhandledRejectionSilencer();
  installPerformanceNowGuard();

  const {
    debug,
    debugEpoch,
    sab,
    thread,
    startAt,
    workerOptions,
    lock,
    returnLock,
    abortSignalSAB,
    abortSignalMax,
    payloadConfig,
    sharedReturn,
    permission,
    notifyOnHostPublish,
    processCompletionDoorbell,
    processAsyncPark,
    processNativeWait,
    denoCompletionDoorbell,
    nodeCompletionDoorbell,
    totalNumberOfThread,
    list,
    ids,
    names,
    at,
    steal,
    unravelShared,
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
        epoch: debugEpoch,
      })
    )
    : undefined;
  if (dbg?.enabled("lifecycle") === true) {
    // Detached task promises reject silently otherwise (see the silencer).
    reportSilencedRejections((reason) =>
      dbg.log(
        "lifecycle",
        `unhandled rejection silenced: ${
          reason instanceof Error ? reason.stack ?? reason.message : String(reason)
        }`,
      )
    );
  }

  // Andromeda cannot parse enums.
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
    slots: lock.slots,
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
    stealClaim: steal?.claim,
    // Undefined unless `steal` is traced, so the claim path stays untouched.
    traceClaim: steal !== undefined && dbg?.enabled("steal") === true
      ? (message: string) => dbg.log("steal", message)
      : undefined,
  });
  const notifyDenoHost = createDenoCompletionNotifier(denoCompletionDoorbell);
  const notifyNodeHost = createNodeCompletionNotifier(nodeCompletionDoorbell);
  const processParentPort = processCompletionDoorbell === true
    ? RUNTIME_PARENT_PORT
    : undefined;
  // Deno and Bun on Windows flush process messages on an event-loop turn.
  // Yield after a completion ring before returning to synchronous polling,
  // otherwise a host waiting on IPC only progresses via its watchdog.
  let processRingPending = false;
  const flushProcessRing = IS_BUN_WINDOWS || RUNTIME === "deno";
  const notifyProcessHost = processParentPort === undefined
    ? undefined
    : flushProcessRing
    ? () => {
      processParentPort.postMessage(PROCESS_COMPLETION_DOORBELL);
      processRingPending = true;
    }
    : () => processParentPort.postMessage(PROCESS_COMPLETION_DOORBELL);
  const returnLockState = lock2({
    slots: returnLock.slots,
    headers: returnLock.headers,
    headerSlotStrideU32: returnLock.headerSlotStrideU32,
    LockBoundSector: returnLock.lockSector,
    payload: returnLock.payload,
    payloadSector: returnLock.payloadSector,
    payloadConfig,
    textCompat: returnLock.textCompat,
    processBoundary: RUNTIME_IS_PROCESS_WORKER,
    sharedReturn: sharedReturn === true,
    // A thread return moves its source before publication. Node transfers the
    // backing-store ownership; Deno and Bun make one owned host copy before
    // the worker drops its pin. Both avoid the borrowed-return lifetime.
    moveReturn: !RUNTIME_IS_PROCESS_WORKER,
    // The host parks on this lock's publication word when it has no work to
    // flush. Request locks are host-produced and must not wake that waiter.
    notifyOnHostPublish: notifyOnHostPublish ||
      notifyDenoHost !== undefined ||
      notifyNodeHost !== undefined ||
      notifyProcessHost !== undefined,
    notifyHostPublish: notifyDenoHost !== undefined
      ? () => notifyDenoHost(thread)
      : notifyNodeHost !== undefined
      ? notifyNodeHost
      : notifyProcessHost,
  });

  const timers = workerOptions?.timers;
  const spinMicroseconds = timers?.spinMicroseconds ??
    (totalNumberOfThread <= 1 ? 50 : 0);
  const parkMs = dbg !== undefined
    ? Number.POSITIVE_INFINITY
    : (timers?.parkMs ?? 1);

  const pauseSpin = (() => {
    const fn = typeof timers?.pauseNanoseconds === "number"
      ? whilePausing({ pauseInNanoseconds: timers.pauseNanoseconds })
      : pauseGeneric;
    return () => fn(); // always a closure wrapper
  })();

  const { opView, rxStatus, asyncReady, txStatus, stopView } = signals;
  const a_store = Atomics.store;
  const a_load = Atomics.load;
  const nativeWaitU32 = processNativeWait === false
    ? undefined
    : getProcessWorkerNativeWaitU32();

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
  // Process workers boot from JSON, which turns `Infinity` into `null`; read
  // either as unlimited instead of a limit no task can fit under.
  const maxAwaitingTasks = workerOptions?.maxAwaitingTasks ??
    Number.POSITIVE_INFINITY;
  const autoAwaiting = maxAwaitingTasks === "auto"
    ? createUnravelController({
      options: workerOptions?.unravel,
      shared: unravelShared === undefined ? undefined : createUnravelShared(unravelShared, thread),
      onUpdate: dbg?.enabled("unravel") === true
        ? (sample) => dbg.log("unravel", JSON.stringify(sample))
        : undefined,
    })
    : undefined;

  const {
    enqueueLock,
    serviceBatchImmediate,
    hasCompleted,
    writeBatch,
    getAwaiting,
    getAwaitingLimit,
    hasSubmitBacklog,
    coldGrow,
    drainReturnReleases,
    releaseDeferredReturns,
  } = createWorkerRxQueue({
    listOfFunctions,
    workerOptions,
    lock: lockState,
    returnLock: returnLockState,
    hasAborted: abortSignals?.hasAborted,
    stealing: steal !== undefined,
    maxAwaitingTasks: autoAwaiting?.getLimit() ?? (maxAwaitingTasks as number),
    autoAwaiting,
    ownership: steal?.awaitingCounts === undefined
      ? undefined
      : createUnravelOwnership(steal.awaitingCounts, steal.consumerId),
    onSlotFree: () => wakeFromBackoff(),
    onSettled: processAsyncPark ? () => wakeAsyncPark() : undefined,
    onAwaitingChange: processAsyncPark ? () => reportAsyncPresence() : undefined,
    // Only ticket batches wider than one can adapt their claim width.
    singleClaimAboveMs: steal !== undefined && steal.claim !== "dekker" &&
        steal.regionLanes > 1
      ? (steal.singleClaimMicroseconds ?? 0) / 1000
      : 0,
  });
  if (sharedReturn === true) installSharedReturn(returnLock.payload);

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
  // Only the awaiting backoff schedules with a delay, so a pending timer is it.
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  let asyncParked = false;
  const ipcProcess = getNodeProcess() as ReturnType<typeof getNodeProcess> & {
    connected?: boolean;
    send?: (message: unknown, callback: (error: Error | null) => void) => boolean;
    removeListener?: (
      event: string,
      handler: (...args: unknown[]) => void,
    ) => void;
  };
  let canAsyncPark = processAsyncPark === true && RUNTIME_IS_PROCESS_WORKER &&
    ipcProcess?.connected === true && typeof ipcProcess.send === "function";
  const wakeAsyncPark = () => {
    if (!asyncParked) return;
    asyncParked = false;
    a_store(rxStatus, 0, 1);
    scheduleMacro();
  };
  const onProcessWake = (message: unknown) => {
    if (message !== PROCESS_WORKER_WAKE) return;
    if (asyncParked) wakeAsyncPark();
    else if (backoffTimer !== undefined) wakeFromBackoff();
  };
  const onDisconnect = () => {
    canAsyncPark = false;
    wakeAsyncPark();
  };
  if (canAsyncPark) {
    ipcProcess.on!("message", onProcessWake);
    ipcProcess.on!("disconnect", onDisconnect);
  }
  let presenceQueued = false;
  let presenceReported = false;
  const reportAsyncPresence = () => {
    if (!canAsyncPark || presenceQueued) return;
    presenceQueued = true;
    processRingPending = true;
    // Coalesce an event-loop turn: immediately resolved promise batches need
    // no active/idle IPC traffic. Long awaits report before the loop parks.
    SET_IMMEDIATE!(() => {
      presenceQueued = false;
      processRingPending = false;
      if (!canAsyncPark || a_load(stopView, 0) !== WORKER_STOP.running) return;
      const active = getAwaiting() > 0;
      if (active === presenceReported) return;
      presenceReported = active;
      try {
        ipcProcess.send!(
          active ? PROCESS_WORKER_ASYNC_ACTIVE : PROCESS_WORKER_ASYNC_IDLE,
          (error) => { if (error) onDisconnect(); },
        );
      } catch {
        onDisconnect();
      }
    });
  };
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
      backoffTimer = setTimeout(loop, delayMs);
      return;
    }
    post2(null);
  };

  // Under "auto" a freed slot refills between ready timer callbacks. Waiting
  // for setImmediate lets a whole cohort of continuations drain before any
  // replacement starts its wait, turning capped concurrency into waves.
  // Coalesced microtask passes per dispatcher turn are bounded, so
  // immediate-promise chains cannot starve timers, stop or abort handling.
  const REFILL_PASSES = 32;
  let refillQueued = false;
  let refillBudget = REFILL_PASSES;
  /** Run the loop now rather than when the pending backoff timer fires. */
  const wakeFromBackoff = () => {
    if (autoAwaiting !== undefined && refillBudget > 0 && !refillQueued) {
      refillQueued = true;
      queueMicrotask(() => {
        refillQueued = false;
        if (stopView[0] !== WORKER_STOP.running || refillBudget <= 0) return;
        --refillBudget;
        pump();
        _serviceBatchImmediate();
      });
    }
    if (backoffTimer === undefined) return;
    clearTimeout(backoffTimer);
    backoffTimer = undefined;
    isInMacro = false;
    scheduleTimer(0);
  };

  const traceSignals = dbg?.enabled("signals") === true;
  const _hasCompleted = hasCompleted;
  const _getAwaiting = getAwaiting;
  const _drainReturnReleases = drainReturnReleases;
  const _releaseDeferredReturns = releaseDeferredReturns;
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

  // Stealing flushes completed work before claiming more; private lanes claim
  // first to keep their single-consumer path short.
  const pump = steal !== undefined
    ? (): boolean => {
      let progressed = false;
      if (_hasCompleted() && _writeBatch(WRITE_MAX) > 0) progressed = true;
      return _enqueueLock() || progressed;
    }
    : (): boolean => {
      const claimed = _enqueueLock();
      return (_hasCompleted() && _writeBatch(WRITE_MAX) > 0) || claimed;
    };

  /** Leave the dispatch loop and acknowledge shutdown. */
  const stopLoop = () => {
    // A shutdown rejects unconsumed calls, so no return can still be adopted.
    // Do not let a worker-isolate exit strand native BufferReference pins.
    _releaseDeferredReturns();
    asyncParked = false;
    ipcProcess?.removeListener?.("message", onProcessWake);
    ipcProcess?.removeListener?.("disconnect", onDisconnect);
    a_store(stopView, 0, WORKER_STOP.acknowledged);
    a_store(rxStatus, 0, 0);
    try {
      port1.close?.();
      port2.close?.();
    } catch {}
    if (IS_ANDROMEDA) {
      (globalThis as { close?: () => void }).close?.();
    }
  };

  const loop = () => {
    if (asyncParked) {
      asyncParked = false;
      a_store(rxStatus, 0, 1);
    }
    refillBudget = REFILL_PASSES;
    isInMacro = false;
    backoffTimer = undefined;
    // Recompute progress on every pass so idle workers can park.
    let progressed = true;
    let awaiting = 0;
    while (true) {
      if (stopView[0] !== WORKER_STOP.running) return stopLoop();
      const passBusy = autoAwaiting?.start();

      progressed = pump();

      _drainReturnReleases();

      if (_serviceBatchImmediate() > 0) progressed = true;

      if ((awaiting = _getAwaiting()) > 0) {
        // Promise callbacks need the loop to yield; delay only when no progress
        // was made, otherwise queued work pays an unnecessary timer hop.
        if (progressed || awaiting !== lastAwaiting) awaitingSpins = 0;
        lastAwaiting = awaiting;
        awaitingSpins++;
        let delay = Math.min(MAX_AWAITING_MS, Math.max(0, awaitingSpins - 1));
        if (autoAwaiting !== undefined) {
          // An idle dispatcher pass is not task CPU.
          if (!progressed) autoAwaiting.exclude(passBusy!);
          // At the cap with queued work, keep checking at the timer floor so
          // the cold slow start and warm idle probes can grow the cap.
          const cold = coldGrow(totalNumberOfThread);
          if (cold === "grew") {
            awaitingSpins = 0;
            scheduleTimer(0);
            return;
          }
          if (cold === "waiting") {
            scheduleTimer(progressed ? 0 : 1);
            return;
          }
          // At the cap no poll can admit work, and a settle that frees a slot
          // wakes the loop directly. Poll only for stop requests then, unless
          // finished results are waiting for return space.
          if (awaiting >= getAwaitingLimit() && !_hasCompleted()) {
            delay = MAX_AWAITING_MS;
          }
        }
        if (canAsyncPark && a_load(asyncReady, 0) === 1 &&
          !progressed && !_hasCompleted()) {
          const token = a_load(opView, 0);
          const atCapacity = awaiting >= getAwaitingLimit();
          // 2 can admit work; 3 is parked at its async admission limit.
          a_store(rxStatus, 0, atCapacity ? 3 : 2);
          // Publish the parked state before rechecking shared work. A host
          // publication either shows up here or observes a parked worker.
          const claimed = pump();
          if (
            claimed || a_load(opView, 0) !== token ||
            a_load(asyncReady, 0) !== 1 || a_load(stopView, 0) !== WORKER_STOP.running
          ) {
            a_store(rxStatus, 0, 1);
            scheduleMacro();
          } else {
            asyncParked = true;
            // A claim can fill the last slot while a publish races with a
            // wake. Hand remaining shared work to a peer with capacity.
            if (atCapacity && steal !== undefined && hasSubmitBacklog()) {
              try {
                ipcProcess.send!(PROCESS_WORKER_ASYNC_BLOCKED, (error) => {
                  if (error) onDisconnect();
                });
              } catch { onDisconnect(); }
            }
            dbg?.log("signals", "idle async-park");
          }
          return;
        }
        scheduleTimer(delay);
        return;
      }
      awaitingSpins = lastAwaiting = 0;

      if (processRingPending) {
        if (!presenceQueued) processRingPending = false;
        scheduleTimer(0);
        return;
      }

      if (!progressed) {
        if (txStatus[Comment.thisIsAHint] === 1) {
          // During a hint spin only host-driven state can change.
          do {
            _pauseSpin();
            if (stopView[0] !== WORKER_STOP.running) return stopLoop();
            if (pump()) break;
          } while (txStatus[Comment.thisIsAHint] === 1);
          continue;
        }
        // Results that could not be written wait on the host freeing return
        // slots, which rings no worker in particular: keep that park short.
        _pauseUntil(
          wakeToken,
          spinMicroseconds,
          _hasCompleted() ? Math.min(parkMs, BLOCKED_RETURN_PARK_MS) : parkMs,
        );
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
