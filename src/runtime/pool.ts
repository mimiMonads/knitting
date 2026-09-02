import { createHostTxQueue } from "./tx-queue.ts";
import {
  cleanupProcessWorkerMemoryQuietly,
  createProcessSharedMemoryAllocator,
  createProcessStealMemoryLayout,
  createProcessWorkerMemoryLayout,
  createProcessWorkerNativeSignalNotifier,
  type ProcessSharedMemoryBacking,
  type ProcessStealMemoryLayout,
  processWorkerUsesIpc,
  readProcessSharedMemorySettings,
  readProcessWorkerCommandPrefix,
  readProcessWorkerRuntime,
  type ResolvedProcessSharedMemorySettings,
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
  WORKER_STOP,
} from "../ipc/transport/shared-memory.ts";
import {
  ChannelHandler,
  type DispatcherCheck,
  hostDispatcherLoop,
} from "./dispatcher.ts";
import type { DenoCompletionDoorbell } from "./deno-doorbell.ts";
import { createNodeCompletionDoorbell } from "./node-doorbell.ts";
import {
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  type StealClaimDiscipline,
  type Task,
} from "../memory/lock.ts";
// Registers the payload codec before any lock is built.
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
  RUNTIME,
} from "../common/runtime.ts";
import {
  HAS_NODE_WORKER_THREADS,
  isProcessCompletionDoorbell,
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

// Bound the wait for a worker to acknowledge loop exit.
const WORKER_STOP_ACK_TIMEOUT_MS = 50;
// Node owns returned BufferReference backing stores in a process-global native
// registry. Give its worker loop a chance to drain deferred producer pins
// before the host falls back to terminate().
const WORKER_STOP_NEEDS_ACK = RUNTIME === "deno" || RUNTIME === "node";

// Keep idle workers self-healing if an Atomics.notify wake is missed.
const DEFAULT_WORKER_PARK_MS = 1;
const SINGLE_WORKER_SPIN_US = 50;
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
  workerCount: number,
): WorkerSettings => {
  const parkMs = options?.timers?.parkMs ?? DEFAULT_WORKER_PARK_MS;
  // `??` and not `||`: an explicit `spinMicroseconds: 0` is the whole point of
  // the multi-worker default and must not fall through to it.
  const spinMicroseconds = options?.timers?.spinMicroseconds ??
    (workerCount <= 1 ? SINGLE_WORKER_SPIN_US : 0);
  if (options === undefined) return { timers: { parkMs, spinMicroseconds } };

  return {
    ...options,
    timers: {
      ...options.timers,
      parkMs,
      spinMicroseconds,
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

/** Build the shared submit and private return buffers for a stealing pool. */
export const resolveStealRegionLanes = (consumers: number): number => {
  for (let lanes = LockBound.slots; lanes >= 1; lanes >>= 1) {
    if (LockBound.slots / lanes >= consumers + 1) return lanes;
  }
  throw new RangeError(
    `${consumers} stealing workers need more than ${LockBound.slots} lanes`,
  );
};

/** Return the widest region allowed by the selected claim discipline. */
export const resolveMaxStealRegionLanes = (
  consumers: number,
  stealClaim?: StealClaimDiscipline,
): number =>
  stealClaim !== undefined && stealClaim !== "dekker"
    ? LockBound.slots
    : resolveStealRegionLanes(consumers);

/** Maximum claimants that leave the protocol's required spare region. */
export const MAX_STEAL_CONSUMERS = LockBound.slots - 1;

export const createStealPoolBuffers = ({
  threads,
  payload,
  sharedArgs,
  regionLanes,
  stealClaim,
  abortSignalCapacity,
  usesAbortSignal,
  processWorker,
}: {
  threads: number;
  payload?: PayloadBufferOptions;
  /** Hand large arguments to workers as borrowed regions. See `unsafe.SharedArgs`. */
  sharedArgs?: boolean;
  regionLanes?: number;
  stealClaim?: StealClaimDiscipline;
  abortSignalCapacity?: number;
  usesAbortSignal?: boolean;
  processWorker?: {
    signalBytes: number;
    sharedMemory: ResolvedProcessSharedMemorySettings;
  };
}) => {
  const basePayloadConfig = resolvePayloadBufferOptions({ options: payload });
  const payloadConfig = processWorker === undefined
    ? basePayloadConfig
    : withFixedPayloadConfig(basePayloadConfig);
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

  // Keep the default width valid for Dekker; wider CAS-mask regions are explicit.
  const maxLanes = resolveMaxStealRegionLanes(threads, stealClaim);
  const lanes = regionLanes === undefined
    ? resolveStealRegionLanes(threads)
    : Math.min(Math.max(1, regionLanes | 0), maxLanes);

  const resolvedAbortSignalCapacity = resolveAbortSignalCapacity(
    abortSignalCapacity,
  );
  const processMemory: ProcessStealMemoryLayout | undefined =
    processWorker === undefined ? undefined : createProcessStealMemoryLayout({
      threads,
      signalBytes: processWorker.signalBytes,
      abortBytes: usesAbortSignal === true
        ? abortSignalByteLength(resolvedAbortSignalCapacity)
        : 0,
      abortSignalMax: usesAbortSignal === true
        ? resolvedAbortSignalCapacity
        : undefined,
      payloadBytes: payloadConfig.payloadMaxByteLength,
      sharedMemory: processWorker.sharedMemory,
    });

  const submitBuffers = processMemory === undefined
    ? (() => {
      const submitCarpet = carpet();
      return toBuffers(submitCarpet.lock, makePayload());
    })()
    : toBuffers(
      processMemory.workers[0]!.controlLayout.lock,
      processMemory.workers[0]!.lockPayload,
    );
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
    stealClaim,
    processBoundary: processMemory !== undefined,
    // Shared arguments are opt-in because the receiving task may outlive the
    // borrowed region.
    sharedReturn: sharedArgs === true,
  });

  const returnBuffers: LockBuffers[] = [];
  const hostReturnLocks: ReturnType<typeof lock2>[] = [];
  for (let i = 0; i < threads; i++) {
    const buffers = processMemory === undefined
      ? toBuffers(carpet().returnLock, makePayload())
      : toBuffers(
        processMemory.workers[i]!.controlLayout.returnLock,
        processMemory.workers[i]!.returnPayload,
      );
    returnBuffers.push(buffers);
    hostReturnLocks.push(lock2({
      headers: buffers.headers,
      headerSlotStrideU32: buffers.headerSlotStrideU32,
      LockBoundSector: buffers.lockSector,
      payload: buffers.payload,
      payloadSector: buffers.payloadSector,
      payloadConfig,
      textCompat: buffers.textCompat,
      processBoundary: processMemory !== undefined,
    }));
  }

  // Abort-aware tasks can execute on any claimant, so all workers and the
  // pool-global queue must observe one bitmap. Per-lane abort buffers would
  // encode an id from one allocator and test it against another lane's bits.
  const abortSignalSAB = usesAbortSignal === true
    ? processMemory?.workers[0]?.controlLayout.abortSignals ??
      createSharedArrayBuffer(
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
    stealClaim,
    processMemory,
    abortSignalSAB,
    abortSignalMax: processMemory?.abortSignalMax ??
      (abortSignalSAB === undefined ? undefined : resolvedAbortSignalCapacity),
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
  workerCount,
  source,
  at,
  workerOptions,
  workerExecArgv,
  permission,
  host,
  payload,
  sharedBytesEnabled,
  abortSignalCapacity,
  usesAbortSignal,
  sharedChannelHandler,
  denoCompletionDoorbell,
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
  /**
   * Workers only, excluding any host inline lane. Drives the spin policy:
   * the inliner runs on the host thread and never spins, so counting it
   * would strip a one-worker pool of the budget it should keep.
   */
  workerCount?: number;

  source?: string;
  workerOptions?: WorkerSettings;
  workerExecArgv?: string[];
  permission?: WorkerData["permission"];
  host?: DispatcherSettings;
  payload?: PayloadBufferOptions;
  sharedBytesEnabled?: boolean;
  abortSignalCapacity?: number;
  usesAbortSignal?: boolean;
  /**
   * When set, this lane keeps its dispatcher state while the pool owns the
   * macro channel that runs all lane checks.
   */
  sharedChannelHandler?: ChannelHandler;
  /** Deno-only native callback shared by every thread worker in this pool. */
  denoCompletionDoorbell?: DenoCompletionDoorbell;
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
    stealClaim?: StealClaimDiscipline;
    abortSignalSAB?: LockBuffers["headers"];
    abortSignalMax?: number;
    processMemory?: ProcessStealMemoryLayout;
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
    withDefaultWorkerTimers(workerOptions, workerCount ?? totalNumberOfThread),
  );
  const useProcessWorkerRuntime = resolvedWorkerOptions.runtime === "process";
  const canUseDenoCompletionDoorbell = !useProcessWorkerRuntime &&
    denoCompletionDoorbell !== undefined;
  const processWorkerRuntime = useProcessWorkerRuntime
    ? readProcessWorkerRuntime(resolvedWorkerOptions)
    : undefined;
  const processWorkerCommandPrefix = useProcessWorkerRuntime
    ? readProcessWorkerCommandPrefix(resolvedWorkerOptions)
    : undefined;
  const canUseProcessCompletionDoorbell = useProcessWorkerRuntime &&
    host?.doorbell !== false &&
    processWorkerUsesIpc({
      processRuntime: processWorkerRuntime,
      commandPrefix: processWorkerCommandPrefix,
    });
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
  // Stealing process workers use their slice of the pool-wide mapping.
  const stealProcessMemory = stealPool?.processMemory;
  const processWorkerMemory = !useProcessWorkerRuntime
    ? undefined
    : stealProcessMemory === undefined
    ? createProcessWorkerMemoryLayout({
      signalBytes,
      abortBytes,
      payloadBytes: resolvedPayloadConfig.payloadMaxByteLength,
      thread,
      sharedMemory: processSharedMemorySettings!,
    })
    : stealProcessMemory.workers[thread] ??
      (() => {
        throw new RangeError(
          `stealing process pool has no shared-memory slice for worker ${thread}`,
        );
      })();
  const processSharedMemory = processWorkerMemory === undefined
    ? createProcessSharedMemoryAllocator(debug)
    : undefined;
  const createControlBuffer = processSharedMemory?.createBuffer ??
    createWasmSharedArrayBuffer;
  const createPayloadBuffer = processSharedMemory?.createBuffer;
  const makePayloadBuffer = () =>
    createPayloadBuffer
      // Process-shared buffers are fixed-size.
      ? createPayloadBuffer(resolvedPayloadConfig.payloadMaxByteLength)
      : resolvedPayloadConfig.mode === "growable"
      ? createSharedArrayBuffer(
        resolvedPayloadConfig.payloadInitialBytes,
        resolvedPayloadConfig.payloadMaxByteLength,
      )
      : createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes);

  const makeLockControlLayout = () => {
    // Place hot control words first; keep headers contiguous and the abort bitmap
    // at the tail.
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

  const queue = stealPool?.sharedQueue ?? createHostTxQueue({
    lock,
    returnLock,
    abortSignals,
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

  // Wake this lane when its worker is parked.
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
  // Create the Node doorbell before bootstrapping the worker.
  let nodeCompletionWake: (() => void) | undefined;
  const nodeCompletionDoorbell = !useProcessWorkerRuntime &&
      host?.doorbell !== false && host?.nativeDoorbell === true
    ? createNodeCompletionDoorbell(() => nodeCompletionWake?.())
    : undefined;
  const canUseNodeCompletionDoorbell = nodeCompletionDoorbell !== undefined;
  // A stealing pool has one dispatcher for its shared queue.
  const {
    check: dispatcherCheck,
    wakeCompletion: directCompletionWake,
  } = stealPool !== undefined
    ? { check: undefined, wakeCompletion: undefined }
    : hostDispatcherLoop({
      signalBox,
      queue,
      channelHandler: ownChannel,
      dispatcherOptions: host,
      notifySignal: nativeNotifySignal,
      crossProcess: useProcessWorkerRuntime,
      nativeCompletionDoorbell: canUseDenoCompletionDoorbell ||
        canUseNodeCompletionDoorbell,
      processCompletionDoorbell: canUseProcessCompletionDoorbell,
    });
  if (canUseDenoCompletionDoorbell && dispatcherCheck !== undefined) {
    denoCompletionDoorbell.listen(thread, directCompletionWake!);
  }
  nodeCompletionWake = directCompletionWake;
  let processCompletionWake = directCompletionWake;
  if (ownsChannel && dispatcherCheck !== undefined) {
    ownChannel.open(dispatcherCheck);
    channelHandler = ownChannel;
    dispatchSend = () => {
      if (dispatcherCheck.isRunning === true) return;
      dispatcherCheck.isRunning = true;
      queueMicrotask(dispatcherCheck);
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
    sharedReturn: sharedBytesEnabled === true,
    permission,
    // Select the completion doorbell supported by the worker runtime.
    notifyOnHostPublish: host?.doorbell !== false &&
      (
        canUseProcessCompletionDoorbell ||
        canUseNodeCompletionDoorbell ||
        (!useProcessWorkerRuntime &&
          (RUNTIME === "bun" || RUNTIME === "node") &&
          typeof Atomics.waitAsync === "function")
      ),
    processCompletionDoorbell: canUseProcessCompletionDoorbell,
    denoCompletionDoorbell: canUseDenoCompletionDoorbell
      ? denoCompletionDoorbell.pointer
      : undefined,
    nodeCompletionDoorbell: canUseNodeCompletionDoorbell
      ? nodeCompletionDoorbell.pointer
      : undefined,
    steal: stealPool === undefined ? undefined : {
      consumers: stealPool.consumers,
      consumerId: stealPool.consumerId,
      regionLanes: stealPool.regionLanes,
      claim: stealPool.stealClaim,
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
  const markWorkerClosed = (reason: string): void => {
    if (closedReason) return;
    closedReason = reason;
    rejectAll(reason);
    channelHandler?.close();
  };

  const onWorkerMessage = (message: unknown) => {
    if (isProcessCompletionDoorbell(message)) {
      processCompletionWake?.();
      return;
    }
    if (!isWorkerFatalMessage(message)) return;
    markWorkerClosed(
      `Worker startup failed: ${message[WORKER_FATAL_MESSAGE_KEY]}`,
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
      deactivateStealConsumer();
      nodeCompletionDoorbell?.close();
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

  const requestWorkerStop = async (): Promise<boolean> => {
    const stopView = signalBox.stopView;
    if (stopView === undefined) return true;
    try {
      Atomics.store(stopView, 0, WORKER_STOP.requested);
      laneWake();
      notifySignal?.();
    } catch {
      return false;
    }
    if (!WORKER_STOP_NEEDS_ACK) return true;
    const deadline = Date.now() + WORKER_STOP_ACK_TIMEOUT_MS;
    while (Atomics.load(stopView, 0) !== WORKER_STOP.acknowledged) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return true;
  };

  const context: WorkerContext & {
    lock: ReturnType<typeof lock2>;
    processSharedMemoryBackings?: readonly ProcessSharedMemoryBacking[];
    dispatcherCheck?: DispatcherCheck;
    laneWake?: () => void;
    bindSend?: (fn: () => void) => void;
    bindCompletionWake?: (fn: () => void) => void;
    processCompletionDoorbell?: boolean;
    nodeCompletionDoorbell?: boolean;
  } = {
    txIdle,
    call,
    requestStop: requestWorkerStop,
    kills: async () => {
      markWorkerClosed("Thread closed");
      // Process workers must exit before their shared memory is unmapped.
      const awaitExit = processWorkerMemory !== undefined;
      const termination = terminateWorkerQuietly(worker, awaitExit);
      if (awaitExit) await termination;
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
    bindCompletionWake: (canUseProcessCompletionDoorbell ||
        canUseNodeCompletionDoorbell) &&
        stealPool !== undefined
      ? ((fn: () => void) => {
        processCompletionWake = fn;
        nodeCompletionWake = fn;
      })
      : undefined,
    processCompletionDoorbell: canUseProcessCompletionDoorbell,
    nodeCompletionDoorbell: canUseNodeCompletionDoorbell,
  };

  return context;
};

export type CreateContext = WorkerContext;
