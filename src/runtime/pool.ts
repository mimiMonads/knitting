import { createHostTxQueue } from "./tx-queue.ts";
import {
  cleanupProcessWorkerMemoryQuietly,
  createProcessSharedMemoryAllocator,
  createProcessWorkerMemoryLayout,
  createProcessWorkerNativeSignalNotifier,
  type ProcessSharedMemoryBacking,
  readProcessSharedMemorySettings,
  readProcessWorkerCommandPrefix,
  readProcessWorkerRuntime,
  spawnProcessWorker,
  toProcessWorkerBootPayload,
} from "./process-worker.ts";
import {
  type NodeWorkerLike,
  serializeWorkerBootstrapData,
  type SpawnedWorker,
  terminateWorkerQuietly,
  toWorkerCompatExecArgv,
  toWorkerSafeExecArgv,
} from "./worker-common.ts";
import {
  createSharedMemoryTransport,
  type Sab,
  TRANSPORT_SIGNAL_BYTES,
} from "../ipc/transport/shared-memory.ts";
import {
  ChannelHandler,
  type DispatcherCheck,
  hostDispatcherLoop,
} from "./dispatcher.ts";
import {
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  type Task,
} from "../memory/lock.ts";
// Side-effect import: registers the payload codec (cycle break for Andromeda;
// see lock.ts). Must run before any lock2() call.
import "../memory/payloadCodec.ts";
import type {
  DebugOptions,
  DispatcherSettings,
  LockBuffers,
  WorkerCall,
  WorkerContext,
  WorkerData,
  WorkerSettings,
} from "../types.ts";
import "../worker/loop.ts";
import {
  createSharedArrayBuffer,
  createWasmSharedArrayBuffer,
  IS_BROWSER,
} from "../common/runtime.ts";
import {
  HAS_NODE_WORKER_THREADS,
  RUNTIME_WORKER,
  type RuntimeWorkerLike,
} from "../common/worker-runtime.ts";
import { probeLockBufferTextCompat } from "../common/shared-buffer-text.ts";
import { signalAbortFactory } from "../shared/abortSignal.ts";
import { createLockControlCarpet } from "../memory/byte-carpet.ts";
import {
  type PayloadBufferOptions,
  resolvePayloadBufferOptions,
} from "../memory/payload-config.ts";
import {
  type BufferReference,
  type BufferReferenceRuntime,
  createBufferReferenceReturnReleaseMessage,
  detachArrayBufferBestEffort,
} from "../connections/buffer-reference.ts";
import { spawnCompiledWorkerContext } from "./compiled-worker.ts";

const WORKER_FATAL_MESSAGE_KEY = "__knittingWorkerFatal";
const isWorkerFatalMessage = (
  value: unknown,
): value is { [WORKER_FATAL_MESSAGE_KEY]: string } =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { [WORKER_FATAL_MESSAGE_KEY]?: unknown })[
      WORKER_FATAL_MESSAGE_KEY
    ] === "string";

// Keep idle workers self-healing if an Atomics.notify wake is missed.
const DEFAULT_WORKER_PARK_MS = 1;
const DEFAULT_ABORT_SIGNAL_CAPACITY = 258;

const sanitizePositiveInteger = (value: number | undefined) => {
  if (!Number.isFinite(value)) return undefined;
  const parsed = Math.floor(value as number);
  return parsed > 0 ? parsed : undefined;
};

const resolveAbortSignalCapacity = (value: number | undefined): number =>
  sanitizePositiveInteger(value) ?? DEFAULT_ABORT_SIGNAL_CAPACITY;

const abortSignalByteLength = (capacity: number): number =>
  Math.max(1, Math.ceil(capacity / 32)) * Uint32Array.BYTES_PER_ELEMENT;

const withDefaultWorkerTimers = (
  options: WorkerSettings | undefined,
): WorkerSettings => {
  const parkMs = options?.timers?.parkMs ?? DEFAULT_WORKER_PARK_MS;
  if (options === undefined) return { timers: { parkMs } };

  return {
    ...options,
    timers: {
      ...options.timers,
      parkMs,
    },
  };
};

const withFixedPayloadConfig = (
  config: ReturnType<typeof resolvePayloadBufferOptions>,
): ReturnType<typeof resolvePayloadBufferOptions> => ({
  ...config,
  mode: "fixed",
  payloadInitialBytes: config.payloadMaxByteLength,
});

/**
 * Build the buffers, host-side locks and pending registry that a stealing pool
 * shares. One submit region for every worker to claim from, one private return
 * region per worker, and a single pool-global queue so a response arriving on
 * any lane settles the right promise.
 *
 * Region width follows paper §6.1: the largest power-of-two `g` leaving a spare
 * region for a delayed claimant (`slots / g >= consumers + 1`). At 32 slots that
 * caps how wide a region can be well before it caps the worker count.
 */
export const resolveStealRegionLanes = (consumers: number): number => {
  for (let lanes = LockBound.slots; lanes >= 1; lanes >>= 1) {
    if (LockBound.slots / lanes >= consumers + 1) return lanes;
  }
  throw new RangeError(
    `${consumers} stealing workers need more than ${LockBound.slots} lanes`,
  );
};

/** Maximum claimants that leave the protocol's required spare region. */
export const MAX_STEAL_CONSUMERS = LockBound.slots - 1;

export const createStealPoolBuffers = ({
  threads,
  payload,
  regionLanes,
  abortSignalCapacity,
  usesAbortSignal,
}: {
  threads: number;
  payload?: PayloadBufferOptions;
  regionLanes?: number;
  abortSignalCapacity?: number;
  usesAbortSignal?: boolean;
}) => {
  const payloadConfig = resolvePayloadBufferOptions({ options: payload });
  const makePayload = () =>
    payloadConfig.mode === "growable"
      ? createSharedArrayBuffer(
        payloadConfig.payloadInitialBytes,
        payloadConfig.payloadMaxByteLength,
      )
      : createSharedArrayBuffer(payloadConfig.payloadInitialBytes);

  const carpet = () =>
    createLockControlCarpet({
      signalBytes: 0,
      abortBytes: 0,
      lockSectorBytes: LOCK_SECTOR_BYTE_LENGTH,
      headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
      slotCount: LockBound.slots,
      headerLayout: "split",
    });

  const toBuffers = (
    half: Omit<LockBuffers, "payload" | "textCompat">,
    payloadSab: LockBuffers["payload"],
  ): LockBuffers =>
    ({
      ...half,
      payload: payloadSab,
      textCompat: probeLockBufferTextCompat({
        headers: half.headers,
        payload: payloadSab,
      }),
    }) as LockBuffers;

  const maxLanes = resolveStealRegionLanes(threads);
  const lanes = regionLanes === undefined
    ? maxLanes
    : Math.min(Math.max(1, regionLanes | 0), maxLanes);

  const submitCarpet = carpet();
  const submitBuffers = toBuffers(submitCarpet.lock, makePayload());
  const hostSubmitLock = lock2({
    headers: submitBuffers.headers,
    headerSlotStrideU32: submitBuffers.headerSlotStrideU32,
    LockBoundSector: submitBuffers.lockSector,
    payload: submitBuffers.payload,
    payloadSector: submitBuffers.payloadSector,
    payloadConfig,
    textCompat: submitBuffers.textCompat,
    consumers: threads,
    regionLanes: lanes,
  });

  const returnBuffers: LockBuffers[] = [];
  const hostReturnLocks: ReturnType<typeof lock2>[] = [];
  for (let i = 0; i < threads; i++) {
    const buffers = toBuffers(carpet().returnLock, makePayload());
    returnBuffers.push(buffers);
    hostReturnLocks.push(lock2({
      headers: buffers.headers,
      headerSlotStrideU32: buffers.headerSlotStrideU32,
      LockBoundSector: buffers.lockSector,
      payload: buffers.payload,
      payloadSector: buffers.payloadSector,
      payloadConfig,
      textCompat: buffers.textCompat,
    }));
  }

  // Abort-aware tasks can execute on any claimant, so all workers and the
  // pool-global queue must observe one bitmap. Per-lane abort buffers would
  // encode an id from one allocator and test it against another lane's bits.
  const resolvedAbortSignalCapacity = resolveAbortSignalCapacity(
    abortSignalCapacity,
  );
  const abortSignalSAB = usesAbortSignal === true
    ? createSharedArrayBuffer(
      abortSignalByteLength(resolvedAbortSignalCapacity),
    )
    : undefined;
  const abortSignals = abortSignalSAB === undefined
    ? undefined
    : signalAbortFactory({
      sab: abortSignalSAB,
      maxSignals: resolvedAbortSignalCapacity,
    });

  const sharedQueue = createHostTxQueue({
    lock: hostSubmitLock,
    returnLock: hostReturnLocks[0]!,
    extraReturnLocks: hostReturnLocks.slice(1),
    abortSignals,
  });

  return {
    submitBuffers,
    returnBuffers,
    hostSubmitLock,
    hostReturnLocks,
    sharedQueue,
    regionLanes: lanes,
    abortSignalSAB,
    abortSignalMax: abortSignalSAB === undefined
      ? undefined
      : resolvedAbortSignalCapacity,
  };
};

export const spawnWorkerContext = ({
  list,
  ids,
  names,
  sab,
  thread,
  debug,
  hostDebug,
  totalNumberOfThread,
  source,
  at,
  workerOptions,
  workerExecArgv,
  permission,
  host,
  payload,
  bufferReferenceReturn,
  abortSignalCapacity,
  usesAbortSignal,
  sharedChannelHandler,
  stealPool,
}: {
  list: string[];
  ids: number[];
  names: string[];
  at: number[];
  sab?: Sab;
  thread: number;
  debug?: DebugOptions;
  hostDebug?: (message: string) => void;
  totalNumberOfThread: number;

  source?: string;
  workerOptions?: WorkerSettings;
  workerExecArgv?: string[];
  permission?: WorkerData["permission"];
  host?: DispatcherSettings;
  payload?: PayloadBufferOptions;
  bufferReferenceReturn?: "copy" | "borrow";
  abortSignalCapacity?: number;
  usesAbortSignal?: boolean;
  /**
   * When set, this lane keeps its dispatcher state while the pool owns the
   * macro channel that runs all lane checks.
   */
  sharedChannelHandler?: ChannelHandler;
  /**
   * Work-stealing wiring. When present the submit region, both host-side locks
   * and the pending registry are owned by `createPool` and shared: every worker
   * claims from one request region, and the host demultiplexes responses by
   * task id. This lane only contributes its private return region and its
   * worker. The dispatcher is owned by the pool too, so none is built here.
   */
  stealPool?: {
    submitBuffers: LockBuffers;
    returnBuffers: LockBuffers;
    hostSubmitLock: ReturnType<typeof lock2>;
    hostReturnLock: ReturnType<typeof lock2>;
    sharedQueue: ReturnType<typeof createHostTxQueue>;
    consumers: number;
    consumerId: number;
    regionLanes: number;
    abortSignalSAB?: LockBuffers["headers"];
    abortSignalMax?: number;
  };
}) => {
  if (workerOptions?.runtime === "compiled") {
    return spawnCompiledWorkerContext({
      list,
      names,
      workerOptions,
      hostDebug,
      abortSignalCapacity,
      usesAbortSignal,
    });
  }

  const tsFileUrl = new URL(import.meta.url);
  const poliWorker = RUNTIME_WORKER;
  const resolvedWorkerOptions = serializeWorkerBootstrapData(
    withDefaultWorkerTimers(workerOptions),
  );
  const useProcessWorkerRuntime = resolvedWorkerOptions.runtime === "process";
  const processWorkerRuntime = useProcessWorkerRuntime
    ? readProcessWorkerRuntime(resolvedWorkerOptions)
    : undefined;
  const processWorkerCommandPrefix = useProcessWorkerRuntime
    ? readProcessWorkerCommandPrefix(resolvedWorkerOptions)
    : undefined;
  const processSharedMemorySettings = useProcessWorkerRuntime
    ? readProcessSharedMemorySettings(resolvedWorkerOptions)
    : undefined;

  if (!useProcessWorkerRuntime && typeof poliWorker !== "function") {
    throw new Error("Worker is not available in this runtime");
  }
  // Without this the failure is a `ReferenceError` from whichever module
  // happens to allocate first.
  if (IS_BROWSER && typeof SharedArrayBuffer !== "function") {
    throw new Error(
      "SharedArrayBuffer is unavailable: serve the page cross-origin isolated " +
        "(Cross-Origin-Opener-Policy: same-origin, " +
        "Cross-Origin-Embedder-Policy: require-corp).",
    );
  }
  const WorkerCtor = poliWorker as NonNullable<typeof poliWorker>;

  // Lock buffers must be shared between host and worker.
  const sanitizeBytes = sanitizePositiveInteger;
  const basePayloadConfig = resolvePayloadBufferOptions({
    options: payload,
  });
  const resolvedPayloadConfig = useProcessWorkerRuntime
    ? withFixedPayloadConfig(basePayloadConfig)
    : basePayloadConfig;
  const resolvedAbortSignalCapacity = resolveAbortSignalCapacity(
    abortSignalCapacity,
  );
  const requestedSignalBytes = sanitizeBytes(sab?.size);
  const externalSignalSab = sab?.sharedSab;
  if (useProcessWorkerRuntime && externalSignalSab != null) {
    throw new Error(
      "process worker runtime cannot use an external signal buffer",
    );
  }
  const signalBytes = Math.max(
    TRANSPORT_SIGNAL_BYTES,
    requestedSignalBytes ?? TRANSPORT_SIGNAL_BYTES,
  );
  const abortBytes = stealPool === undefined && usesAbortSignal === true
    ? abortSignalByteLength(resolvedAbortSignalCapacity)
    : 0;
  const processWorkerMemory = useProcessWorkerRuntime
    ? createProcessWorkerMemoryLayout({
      signalBytes,
      abortBytes,
      payloadBytes: resolvedPayloadConfig.payloadMaxByteLength,
      thread,
      sharedMemory: processSharedMemorySettings!,
    })
    : undefined;
  const processSharedMemory = processWorkerMemory === undefined
    ? createProcessSharedMemoryAllocator(debug)
    : undefined;
  const createControlBuffer = processSharedMemory?.createBuffer ??
    createWasmSharedArrayBuffer;
  const createPayloadBuffer = processSharedMemory?.createBuffer;
  const makePayloadBuffer = () =>
    createPayloadBuffer
      // ProcessSharedBuffer is fixed-size today, so reserve the configured
      // payload ceiling instead of relying on SAB growth.
      ? createPayloadBuffer(resolvedPayloadConfig.payloadMaxByteLength)
      : resolvedPayloadConfig.mode === "growable"
      ? createSharedArrayBuffer(
        resolvedPayloadConfig.payloadInitialBytes,
        resolvedPayloadConfig.payloadMaxByteLength,
      )
      : createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes);

  const makeLockControlLayout = () => {
    // Keep the hottest control words in one compact front strip:
    // transport signals -> request lock -> return lock.
    // Request/return headers stay in separate contiguous slabs to preserve
    // sequential batching locality.
    // Abort bitmap stays at the tail.
    return createLockControlCarpet({
      signalBytes,
      abortBytes,
      lockSectorBytes: LOCK_SECTOR_BYTE_LENGTH,
      headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
      slotCount: LockBound.slots,
      headerLayout: "split",
      createBuffer: createControlBuffer,
    });
  };

  const controlLayout = processWorkerMemory?.controlLayout ??
    makeLockControlLayout();
  const lockPayload = processWorkerMemory?.lockPayload ?? makePayloadBuffer();
  const lockBuffers: LockBuffers = stealPool?.submitBuffers ?? {
    ...controlLayout.lock,
    payload: lockPayload,
    textCompat: probeLockBufferTextCompat({
      headers: controlLayout.lock.headers,
      payload: lockPayload,
    }),
  };
  const returnPayload = processWorkerMemory?.returnPayload ??
    makePayloadBuffer();
  const returnLockBuffers: LockBuffers = stealPool?.returnBuffers ?? {
    ...controlLayout.returnLock,
    payload: returnPayload,
    textCompat: probeLockBufferTextCompat({
      headers: controlLayout.returnLock.headers,
      payload: returnPayload,
    }),
  };

  const lock = stealPool?.hostSubmitLock ?? lock2({
    headers: lockBuffers.headers,
    headerSlotStrideU32: lockBuffers.headerSlotStrideU32,
    LockBoundSector: lockBuffers.lockSector,
    payload: lockBuffers.payload,
    payloadSector: lockBuffers.payloadSector,
    payloadConfig: resolvedPayloadConfig,
    textCompat: lockBuffers.textCompat,
    processBoundary: useProcessWorkerRuntime,
  });
  const returnLock = stealPool?.hostReturnLock ?? lock2({
    headers: returnLockBuffers.headers,
    headerSlotStrideU32: returnLockBuffers.headerSlotStrideU32,
    LockBoundSector: returnLockBuffers.lockSector,
    payload: returnLockBuffers.payload,
    payloadSector: returnLockBuffers.payloadSector,
    payloadConfig: resolvedPayloadConfig,
    textCompat: returnLockBuffers.textCompat,
    processBoundary: useProcessWorkerRuntime,
  });
  const abortSignalSAB = stealPool?.abortSignalSAB ??
    (usesAbortSignal === true ? controlLayout.abortSignals : undefined);
  const abortSignals = abortSignalSAB && stealPool === undefined
    ? signalAbortFactory({
      sab: abortSignalSAB,
      maxSignals: resolvedAbortSignalCapacity,
    })
    : undefined;

  const signals = createSharedMemoryTransport({
    sabObject: externalSignalSab == null
      ? {
        size: requestedSignalBytes,
        sharedSab: controlLayout.signals,
      }
      : sab,
    isMain: true,
    thread,
  });
  const signalBox = signals;
  const nativeNotifySignal = createProcessWorkerNativeSignalNotifier({
    processRuntime: processWorkerRuntime,
    signal: signalBox.opView,
  });

  // Outstanding borrowed returns, revoked before this lane's worker dies so
  // no borrowed alias can outlive the isolate that pins its bytes.
  type BorrowedReturnRecord = {
    ref: WeakRef<BufferReference>;
    /** Set on first materialize; absent while the borrow was never read. */
    aliasBuffer?: WeakRef<ArrayBuffer>;
    runtime: BufferReferenceRuntime;
  };

  const outstandingBorrowedReturns =
    bufferReferenceReturn === "borrow" && typeof WeakRef === "function"
      ? new Map<bigint, BorrowedReturnRecord>()
      : undefined;

  const releaseBorrowedReturnToken = (token: bigint): void => {
    outstandingBorrowedReturns?.delete(token);
    worker?.postMessage?.(
      createBufferReferenceReturnReleaseMessage(token),
    );
  };

  const revokeOutstandingBorrowedReturns = (copyBytes: boolean): void => {
    if (outstandingBorrowedReturns === undefined) return;
    for (const [token, record] of outstandingBorrowedReturns) {
      try {
        const ref = record.ref.deref();
        if (ref !== undefined) {
          ref.revokeBorrow(copyBytes);
          continue;
        }

        const aliasBuffer = record.aliasBuffer?.deref();
        if (
          aliasBuffer !== undefined &&
          detachArrayBufferBestEffort(record.runtime, aliasBuffer) &&
          copyBytes
        ) {
          releaseBorrowedReturnToken(token);
        }
      } catch {
        // best effort
      }
    }
    outstandingBorrowedReturns.clear();
  };

  const returnHooks = bufferReferenceReturn === "borrow"
    ? {
      release: releaseBorrowedReturnToken,
      track: (
        ref: BufferReference,
        token: bigint,
        aliasBuffer?: ArrayBuffer,
      ) => {
        if (outstandingBorrowedReturns === undefined) return;
        const record = outstandingBorrowedReturns.get(token);
        if (record !== undefined) {
          if (aliasBuffer !== undefined) {
            record.aliasBuffer = new WeakRef(aliasBuffer);
          }
          return;
        }
        outstandingBorrowedReturns.set(token, {
          ref: new WeakRef(ref),
          aliasBuffer: aliasBuffer === undefined
            ? undefined
            : new WeakRef(aliasBuffer),
          runtime: ref.runtime,
        });
      },
    }
    : undefined;

  const queue = stealPool?.sharedQueue ?? createHostTxQueue({
    lock,
    returnLock,
    abortSignals,
    releaseBufferReferenceReturn: returnHooks,
  });
  if (stealPool !== undefined) {
    stealPool.sharedQueue.setReturnHooks(stealPool.consumerId, returnHooks);
  }

  const {
    enqueue,
    rejectAll,
    txIdle,
  } = queue;
  const thisSignal = signalBox.opView;
  const a_add = Atomics.add;
  const a_load = Atomics.load;
  const a_notify = Atomics.notify;
  const canNotifySignal = thisSignal.buffer instanceof SharedArrayBuffer;
  const notifySignal = nativeNotifySignal ??
    (canNotifySignal ? (() => a_notify(thisSignal, 0, 1)) : undefined);

  // Wakes this lane's worker when it is parked (rxStatus 0). Used by send()
  // (new work just arrived) — the dispatcher drain wakes it the same way.
  const laneWake = () => {
    if (a_load(signalBox.rxStatus, 0) === 0) {
      a_add(thisSignal, 0, 1);
      notifySignal?.();
    }
  };

  let dispatchSend: () => void = () => {};
  const send = () => dispatchSend();

  let channelHandler: ChannelHandler | undefined;
  const ownsChannel = sharedChannelHandler === undefined &&
    stealPool === undefined;
  const ownChannel = sharedChannelHandler ?? new ChannelHandler();
  // Under stealing there is one queue, so one dispatcher drives it from the
  // pool; a per-lane dispatcher would double-drain the shared registry.
  const { check: dispatcherCheck } = stealPool !== undefined
    ? { check: undefined }
    : hostDispatcherLoop({
      signalBox,
      queue,
      channelHandler: ownChannel,
      dispatcherOptions: host,
      notifySignal: nativeNotifySignal,
    });
  if (ownsChannel && dispatcherCheck !== undefined) {
    ownChannel.open(dispatcherCheck);
    channelHandler = ownChannel;
    dispatchSend = () => {
      if (dispatcherCheck.isRunning === true) return;
      dispatcherCheck.isRunning = true;
      Promise.resolve().then(dispatcherCheck);
      laneWake();
    };
  }

  let worker: SpawnedWorker;

  const workerUrl = source ?? tsFileUrl;
  const workerMode = useProcessWorkerRuntime
    ? "process"
    : HAS_NODE_WORKER_THREADS
    ? "worker_threads"
    : "worker";
  hostDebug?.(
    `worker thread=${thread} mode=${workerMode}` +
      `${processWorkerRuntime ? ` runtime=${processWorkerRuntime}` : ""}` +
      ` url=${String(workerUrl)}`,
  );
  const workerDataPayload = {
    sab: signals.sab,
    abortSignalSAB,
    abortSignalMax: stealPool?.abortSignalMax ??
      (usesAbortSignal === true ? resolvedAbortSignalCapacity : undefined),
    list,
    ids,
    names,
    at,
    thread,
    debug,
    workerOptions: resolvedWorkerOptions,
    totalNumberOfThread,
    startAt: signalBox.startAt,
    lock: lockBuffers,
    returnLock: returnLockBuffers,
    payloadConfig: resolvedPayloadConfig,
    bufferReferenceReturn,
    permission,
    steal: stealPool === undefined ? undefined : {
      consumers: stealPool.consumers,
      consumerId: stealPool.consumerId,
      regionLanes: stealPool.regionLanes,
    },
  } as WorkerData;
  const baseWorkerOptions = {
    //@ts-ignore Reason
    type: "module",
    //@ts-ignore
    workerData: workerDataPayload,
  } as {
    type: "module";
    workerData: WorkerData;
    execArgv?: string[];
  };
  const withExecArgv = workerExecArgv && workerExecArgv.length > 0
    ? { ...baseWorkerOptions, execArgv: workerExecArgv }
    : baseWorkerOptions;
  if (processWorkerMemory !== undefined) {
    worker = spawnProcessWorker({
      workerUrl,
      bootPayload: toProcessWorkerBootPayload(
        workerDataPayload,
        processWorkerMemory,
      ),
      memory: processWorkerMemory,
      processRuntime: processWorkerRuntime!,
      commandPrefix: processWorkerCommandPrefix,
      permission,
    });
  } else if (HAS_NODE_WORKER_THREADS) {
    try {
      worker = new WorkerCtor(workerUrl, withExecArgv) as RuntimeWorkerLike;
    } catch (error) {
      if (
        (error as { code?: string })?.code === "ERR_WORKER_INVALID_EXEC_ARGV"
      ) {
        const fallbackExecArgv = toWorkerSafeExecArgv(withExecArgv.execArgv);
        if (fallbackExecArgv && fallbackExecArgv.length > 0) {
          try {
            worker = new WorkerCtor(
              workerUrl,
              { ...baseWorkerOptions, execArgv: fallbackExecArgv },
            ) as RuntimeWorkerLike;
          } catch (fallbackError) {
            if (
              (fallbackError as { code?: string })?.code ===
                "ERR_WORKER_INVALID_EXEC_ARGV"
            ) {
              const compatExecArgv = toWorkerCompatExecArgv(fallbackExecArgv);
              if (compatExecArgv && compatExecArgv.length > 0) {
                try {
                  worker = new WorkerCtor(
                    workerUrl,
                    { ...baseWorkerOptions, execArgv: compatExecArgv },
                  ) as RuntimeWorkerLike;
                } catch {
                  worker = new WorkerCtor(
                    workerUrl,
                    baseWorkerOptions,
                  ) as RuntimeWorkerLike;
                }
              } else {
                worker = new WorkerCtor(
                  workerUrl,
                  baseWorkerOptions,
                ) as RuntimeWorkerLike;
              }
            } else {
              throw fallbackError;
            }
          }
        } else {
          worker = new WorkerCtor(
            workerUrl,
            baseWorkerOptions,
          ) as RuntimeWorkerLike;
        }
      } else {
        throw error;
      }
    }
  } else {
    worker = new WorkerCtor(
      workerUrl,
      {
        type: "module",
      },
    ) as RuntimeWorkerLike;
    worker.postMessage?.(workerDataPayload);
  }

  let closedReason: string | undefined;
  const deactivateStealConsumer = () => {
    stealPool?.hostSubmitLock.deactivateStealConsumer(
      stealPool.consumerId,
    );
  };
  const terminateFailedWorker = () => {
    try {
      worker.unref?.();
      void Promise.resolve(worker.terminate())
        .catch(() => {})
        .finally(deactivateStealConsumer);
    } catch {
      deactivateStealConsumer();
    }
  };
  // `workerBytesReadable`: while the worker is still alive its pinned bytes
  // can be copied out; after a crash/exit they are gone and borrows are
  // detached so stale reads fail loud instead of aliasing freed memory.
  const markWorkerClosed = (
    reason: string,
    workerBytesReadable = false,
  ): void => {
    if (closedReason) return;
    closedReason = reason;
    revokeOutstandingBorrowedReturns(workerBytesReadable);
    rejectAll(reason);
    channelHandler?.close();
  };

  const onWorkerMessage = (message: unknown) => {
    if (!isWorkerFatalMessage(message)) return;
    markWorkerClosed(
      `Worker startup failed: ${message[WORKER_FATAL_MESSAGE_KEY]}`,
      true,
    );
    terminateFailedWorker();
  };
  const onWorkerError = (error: unknown) => {
    const message = String((error as { message?: unknown })?.message ?? error);
    markWorkerClosed(`Worker crashed: ${message}`);
    terminateFailedWorker();
  };
  const nodeWorker = worker as unknown as NodeWorkerLike;
  if (typeof nodeWorker.on === "function") {
    nodeWorker.on("message", onWorkerMessage);
    nodeWorker.on("error", onWorkerError);
    nodeWorker.on("exit", (code: unknown) => {
      // Exit is the point at which this endpoint can no longer write WANT, so
      // survivors may safely ignore any intent it left behind.
      deactivateStealConsumer();
      if (closedReason !== undefined) return;
      const normalized = typeof code === "number" ? code : -1;
      markWorkerClosed(`Worker exited with code ${normalized}`);
    });
  } else {
    const eventWorker = worker as RuntimeWorkerLike & {
      addEventListener?: (
        type: string,
        listener: (
          event: { data?: unknown; error?: unknown; message?: unknown },
        ) => void,
      ) => void;
      onerror?: ((event: unknown) => void) | null;
    };
    if (typeof eventWorker.addEventListener === "function") {
      eventWorker.addEventListener("message", (event) => {
        onWorkerMessage(event?.data);
      });
      eventWorker.addEventListener("error", (event) => {
        onWorkerError(event?.error ?? event?.message ?? event);
      });
    } else {
      eventWorker.onmessage = (event) => {
        onWorkerMessage(event?.data);
      };
      eventWorker.onerror = (event) => {
        onWorkerError(event);
      };
    }
  }

  lock.setPromiseHandler((task: Task, isRejected: boolean, value: unknown) => {
    queue.settlePromisePayload(task, isRejected, value);
    send();
  });

  const call = ({ fnNumber, timeout, abortSignal }: WorkerCall) => {
    const enqueues = enqueue(fnNumber, timeout, abortSignal);

    return (args: Uint8Array) => {
      const pending = enqueues(args);
      send();
      return pending;
    };
  };

  const context: WorkerContext & {
    lock: ReturnType<typeof lock2>;
    processSharedMemoryBackings?: readonly ProcessSharedMemoryBacking[];
    dispatcherCheck?: DispatcherCheck;
    laneWake?: () => void;
    bindSend?: (fn: () => void) => void;
  } = {
    txIdle,
    call,
    kills: async () => {
      markWorkerClosed("Thread closed", true);
      terminateWorkerQuietly(worker);
      cleanupProcessWorkerMemoryQuietly(processWorkerMemory);
    },
    lock,
    processSharedMemoryBackings: processSharedMemory?.backings,
    dispatcherCheck,
    laneWake: sharedChannelHandler !== undefined || stealPool !== undefined
      ? laneWake
      : undefined,
    bindSend: sharedChannelHandler !== undefined || stealPool !== undefined
      ? ((fn: () => void) => void (dispatchSend = fn))
      : undefined,
  };

  return context;
};

export type CreateContext = WorkerContext;
