import { createHostTxQueue } from "./tx-queue.ts";
import {
  cleanupProcessWorkerMemoryQuietly,
  createProcessSharedMemoryAllocator,
  createProcessWorkerMemoryLayout,
  createProcessWorkerNativeSignalNotifier,
  type NodeWorkerLike,
  type ProcessSharedMemoryBacking,
  readProcessSharedMemorySettings,
  readProcessWorkerCommandPrefix,
  readProcessWorkerRuntime,
  serializeWorkerBootstrapData,
  type SpawnedWorker,
  spawnProcessWorker,
  terminateWorkerQuietly,
  toProcessWorkerBootPayload,
  toWorkerCompatExecArgv,
  toWorkerSafeExecArgv,
} from "./process-worker.ts";
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
}) => {
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
  const WorkerCtor = poliWorker as NonNullable<typeof poliWorker>;

  // Lock buffers must be shared between host and worker.
  const sanitizeBytes = (value: number | undefined) => {
    if (!Number.isFinite(value)) return undefined;
    const bytes = Math.floor(value as number);
    return bytes > 0 ? bytes : undefined;
  };
  const basePayloadConfig = resolvePayloadBufferOptions({
    options: payload,
  });
  const resolvedPayloadConfig = useProcessWorkerRuntime
    ? withFixedPayloadConfig(basePayloadConfig)
    : basePayloadConfig;
  const defaultAbortSignalCapacity = 258;
  const requestedAbortSignalCapacity = sanitizeBytes(abortSignalCapacity);
  const resolvedAbortSignalCapacity = requestedAbortSignalCapacity ??
    defaultAbortSignalCapacity;
  const abortSignalWords = Math.max(
    1,
    Math.ceil(resolvedAbortSignalCapacity / 32),
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
  const abortBytes = abortSignalWords * Uint32Array.BYTES_PER_ELEMENT;
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
  const lockBuffers: LockBuffers = {
    ...controlLayout.lock,
    payload: lockPayload,
    textCompat: probeLockBufferTextCompat({
      headers: controlLayout.lock.headers,
      payload: lockPayload,
    }),
  };
  const returnPayload = processWorkerMemory?.returnPayload ??
    makePayloadBuffer();
  const returnLockBuffers: LockBuffers = {
    ...controlLayout.returnLock,
    payload: returnPayload,
    textCompat: probeLockBufferTextCompat({
      headers: controlLayout.returnLock.headers,
      payload: returnPayload,
    }),
  };

  const lock = lock2({
    headers: lockBuffers.headers,
    headerSlotStrideU32: lockBuffers.headerSlotStrideU32,
    LockBoundSector: lockBuffers.lockSector,
    payload: lockBuffers.payload,
    payloadSector: lockBuffers.payloadSector,
    payloadConfig: resolvedPayloadConfig,
    textCompat: lockBuffers.textCompat,
    processBoundary: useProcessWorkerRuntime,
  });
  const returnLock = lock2({
    headers: returnLockBuffers.headers,
    headerSlotStrideU32: returnLockBuffers.headerSlotStrideU32,
    LockBoundSector: returnLockBuffers.lockSector,
    payload: returnLockBuffers.payload,
    payloadSector: returnLockBuffers.payloadSector,
    payloadConfig: resolvedPayloadConfig,
    textCompat: returnLockBuffers.textCompat,
    processBoundary: useProcessWorkerRuntime,
  });
  const abortSignalSAB = usesAbortSignal === true
    ? controlLayout.abortSignals
    : undefined;
  const abortSignals = abortSignalSAB
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

  const queue = createHostTxQueue({
    lock,
    returnLock,
    abortSignals,
    releaseBufferReferenceReturn: bufferReferenceReturn === "borrow"
      ? {
        release: releaseBorrowedReturnToken,
        track: (ref, token, aliasBuffer) => {
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
      : undefined,
  });

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
  const ownsChannel = sharedChannelHandler === undefined;
  const ownChannel = sharedChannelHandler ?? new ChannelHandler();
  const { check: dispatcherCheck } = hostDispatcherLoop({
    signalBox,
    queue,
    channelHandler: ownChannel,
    dispatcherOptions: host,
    notifySignal: nativeNotifySignal,
  });
  if (ownsChannel) {
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
    abortSignalMax: usesAbortSignal === true
      ? resolvedAbortSignalCapacity
      : undefined,
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
    terminateWorkerQuietly(worker);
  };
  const onWorkerError = (error: unknown) => {
    const message = String((error as { message?: unknown })?.message ?? error);
    markWorkerClosed(`Worker crashed: ${message}`);
  };
  const nodeWorker = worker as unknown as NodeWorkerLike;
  if (typeof nodeWorker.on === "function") {
    nodeWorker.on("message", onWorkerMessage);
    nodeWorker.on("error", onWorkerError);
    nodeWorker.on("exit", (code: unknown) => {
      if (typeof code === "number" && code === 0) return;
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
    laneWake: sharedChannelHandler !== undefined ? laneWake : undefined,
    bindSend: sharedChannelHandler !== undefined
      ? ((fn: () => void) => void (dispatchSend = fn))
      : undefined,
  };

  return context;
};

export type CreateContext = WorkerContext;
