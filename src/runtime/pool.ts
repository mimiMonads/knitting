// main.ts

import { createHostTxQueue } from "./tx-queue.ts";
import {
  createSharedMemoryTransport,
  type Sab,
  TRANSPORT_SIGNAL_BYTES,
} from "../ipc/transport/shared-memory.ts";
import { ChannelHandler, hostDispatcherLoop } from "./dispatcher.ts";
import {
  HEADER_BYTE_LENGTH,
  type Lock2,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  type Task,
} from "../memory/lock.ts";
import type {
  DebugOptions,
  DispatcherSettings,
  LockBuffers,
  SharedBufferRegion,
  WorkerCall,
  WorkerContext,
  WorkerData,
  WorkerResourceLimits,
  WorkerSettings,
} from "../types.ts";
import { jsrIsGreatAndWorkWithoutBugs } from "../worker/loop.ts";
import {
  createSharedArrayBuffer,
  createWasmSharedArrayBuffer,
} from "../common/runtime.ts";
import { signalAbortFactory } from "../shared/abortSignal.ts";
import { Worker } from "node:worker_threads";
import {
  type PayloadBufferOptions,
  resolvePayloadBufferOptions,
} from "../memory/payload-config.ts";

//const isBrowser = typeof window !== "undefined";

let poliWorker = Worker;

type SpawnedWorker = {
  terminate: () => unknown;
  postMessage?: (message: unknown) => void;
};

type NodeWorkerLike = {
  on?: (
    event: "error" | "exit" | "message",
    listener: (...args: unknown[]) => void,
  ) => void;
};
const WORKER_FATAL_MESSAGE_KEY = "__knittingWorkerFatal";
const execFlagKey = (flag: string): string => flag.split("=", 1)[0]!;
const NODE_PERMISSION_EXEC_FLAGS = new Set<string>([
  "--permission",
  "--experimental-permission",
  "--allow-fs-read",
  "--allow-fs-write",
  "--allow-worker",
  "--allow-child-process",
  "--allow-addons",
  "--allow-wasi",
]);
const NODE_WORKER_SAFE_EXEC_FLAGS = new Set<string>([
  "--experimental-transform-types",
  "--expose-gc",
  "--no-warnings",
  ...NODE_PERMISSION_EXEC_FLAGS,
]);

const isWorkerFatalMessage = (
  value: unknown,
): value is { [WORKER_FATAL_MESSAGE_KEY]: string } =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { [WORKER_FATAL_MESSAGE_KEY]?: unknown })[
      WORKER_FATAL_MESSAGE_KEY
    ] === "string";

const isNodeWorkerSafeExecFlag = (flag: string): boolean =>
  NODE_WORKER_SAFE_EXEC_FLAGS.has(execFlagKey(flag));

const isNodePermissionExecFlag = (flag: string): boolean =>
  NODE_PERMISSION_EXEC_FLAGS.has(execFlagKey(flag));

const toWorkerSafeExecArgv = (
  flags: string[] | undefined,
): string[] | undefined => {
  if (!flags || flags.length === 0) return undefined;
  const filtered = flags.filter(isNodeWorkerSafeExecFlag);
  if (filtered.length === 0) return undefined;
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const flag of filtered) {
    if (seen.has(flag)) continue;
    seen.add(flag);
    deduped.push(flag);
  }
  return deduped;
};

const toWorkerCompatExecArgv = (
  flags: string[] | undefined,
): string[] | undefined => {
  const safe = toWorkerSafeExecArgv(flags);
  if (!safe || safe.length === 0) return undefined;
  const compat = safe.filter((flag) => !isNodePermissionExecFlag(flag));
  return compat.length > 0 ? compat : undefined;
};

type NodeWorkerResourceLimits = {
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  codeRangeSizeMb?: number;
  stackSizeMb?: number;
};

const toPositiveInteger = (value: number | undefined): number | undefined => {
  if (!Number.isFinite(value)) return undefined;
  const int = Math.floor(value as number);
  return int > 0 ? int : undefined;
};

const CONTROL_LAYOUT_ALIGN_BYTES = 64;
const alignControlBytes = (value: number): number =>
  (value + (CONTROL_LAYOUT_ALIGN_BYTES - 1)) &
  ~(CONTROL_LAYOUT_ALIGN_BYTES - 1);

const makeSharedBufferRegion = (
  sab: SharedArrayBuffer,
  byteOffset: number,
  byteLength: number,
): SharedBufferRegion => ({
  sab,
  byteOffset,
  byteLength,
});

const toNodeWorkerResourceLimits = (
  limits: WorkerResourceLimits | undefined,
): NodeWorkerResourceLimits | undefined => {
  if (!limits) return undefined;
  const out: NodeWorkerResourceLimits = {
    maxOldGenerationSizeMb: toPositiveInteger(limits.maxOldGenerationSizeMb),
    maxYoungGenerationSizeMb: toPositiveInteger(
      limits.maxYoungGenerationSizeMb,
    ),
    codeRangeSizeMb: toPositiveInteger(limits.codeRangeSizeMb),
    stackSizeMb: toPositiveInteger(limits.stackSizeMb),
  };
  return Object.values(out).some((value) => value !== undefined)
    ? out
    : undefined;
};

const terminateWorkerQuietly = (worker: SpawnedWorker): void => {
  try {
    void Promise.resolve(worker.terminate()).catch(() => {});
  } catch {
  }
};

export const spawnWorkerContext = ({
  list,
  ids,
  sab,
  thread,
  debug,
  totalNumberOfThread,
  source,
  at,
  workerOptions,
  workerExecArgv,
  permission,
  host,
  payload,
  payloadInitialBytes,
  payloadMaxBytes,
  bufferMode,
  maxPayloadBytes,
  abortSignalCapacity,
  usesAbortSignal,
}: {
  list: string[];
  ids: number[];
  at: number[];
  sab?: Sab;
  thread: number;
  debug?: DebugOptions;
  totalNumberOfThread: number;

  source?: string;
  workerOptions?: WorkerSettings;
  workerExecArgv?: string[];
  permission?: WorkerData["permission"];
  host?: DispatcherSettings;
  payload?: PayloadBufferOptions;
  payloadInitialBytes?: number;
  payloadMaxBytes?: number;
  bufferMode?: PayloadBufferOptions["mode"];
  maxPayloadBytes?: number;
  abortSignalCapacity?: number;
  usesAbortSignal?: boolean;
}) => {
  const tsFileUrl = new URL(import.meta.url);

  if (debug?.logHref === true) {
    console.log(tsFileUrl);
    jsrIsGreatAndWorkWithoutBugs();
  }

  // Lock buffers must be shared between host and worker.
  const sanitizeBytes = (value: number | undefined) => {
    if (!Number.isFinite(value)) return undefined;
    const bytes = Math.floor(value as number);
    return bytes > 0 ? bytes : undefined;
  };
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    options: {
      ...payload,
      mode: payload?.mode ?? bufferMode,
      maxPayloadBytes: payload?.maxPayloadBytes ?? maxPayloadBytes,
      payloadInitialBytes: payload?.payloadInitialBytes ??
        sanitizeBytes(payloadInitialBytes),
      payloadMaxByteLength: payload?.payloadMaxByteLength ??
        sanitizeBytes(payloadMaxBytes),
    },
  });
  const makePayloadBuffer = () =>
    resolvedPayloadConfig.mode === "growable"
      ? createSharedArrayBuffer(
        resolvedPayloadConfig.payloadInitialBytes,
        resolvedPayloadConfig.payloadMaxByteLength,
      )
      : createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes);
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

  const makeLockControlLayout = () => {
    const signalBytes = alignControlBytes(
      Math.max(
        TRANSPORT_SIGNAL_BYTES,
        requestedSignalBytes ?? TRANSPORT_SIGNAL_BYTES,
      ),
    );
    const lockSectorBytes = alignControlBytes(LOCK_SECTOR_BYTE_LENGTH);
    const headerBytes = alignControlBytes(HEADER_BYTE_LENGTH);
    const returnLockOffset = signalBytes + lockSectorBytes + headerBytes;
    const returnHeaderOffset = returnLockOffset + lockSectorBytes;
    const abortOffset = returnHeaderOffset + headerBytes;
    const abortBytes = alignControlBytes(
      abortSignalWords * Uint32Array.BYTES_PER_ELEMENT,
    );
    const controlSAB = createWasmSharedArrayBuffer(
      abortOffset + abortBytes,
    );
    const signals = makeSharedBufferRegion(
      controlSAB,
      0,
      signalBytes,
    );
    const lockSector = makeSharedBufferRegion(
      controlSAB,
      signalBytes,
      LOCK_SECTOR_BYTE_LENGTH,
    );
    const headers = makeSharedBufferRegion(
      controlSAB,
      signalBytes + lockSectorBytes,
      HEADER_BYTE_LENGTH,
    );
    const returnLockSector = makeSharedBufferRegion(
      controlSAB,
      returnLockOffset,
      LOCK_SECTOR_BYTE_LENGTH,
    );
    const returnHeaders = makeSharedBufferRegion(
      controlSAB,
      returnHeaderOffset,
      HEADER_BYTE_LENGTH,
    );
    const abortSignals = makeSharedBufferRegion(
      controlSAB,
      abortOffset,
      abortSignalWords * Uint32Array.BYTES_PER_ELEMENT,
    );
    return {
      signals,
      abortSignals,
      lock: {
        headers,
        lockSector,
        payloadSector: lockSector,
      },
      returnLock: {
        headers: returnHeaders,
        lockSector: returnLockSector,
        payloadSector: returnLockSector,
      },
    };
  };

  const controlLayout = makeLockControlLayout();
  const lockBuffers: LockBuffers = {
    ...controlLayout.lock,
    payload: makePayloadBuffer(),
  };
  const returnLockBuffers: LockBuffers = {
    ...controlLayout.returnLock,
    payload: makePayloadBuffer(),
  };

  const lock = lock2({
    headers: lockBuffers.headers,
    LockBoundSector: lockBuffers.lockSector,
    payload: lockBuffers.payload,
    payloadSector: lockBuffers.payloadSector,
    payloadConfig: resolvedPayloadConfig,
  });
  const returnLock = lock2({
    headers: returnLockBuffers.headers,
    LockBoundSector: returnLockBuffers.lockSector,
    payload: returnLockBuffers.payload,
    payloadSector: returnLockBuffers.payloadSector,
    payloadConfig: resolvedPayloadConfig,
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
    debug,
  });
  const signalBox = signals;

  const queue = createHostTxQueue({
    lock,
    returnLock,
    abortSignals,
  });

  const {
    enqueue,
    rejectAll,
    txIdle,
  } = queue;
  const channelHandler = new ChannelHandler();

  const { check } = hostDispatcherLoop({
    signalBox,
    queue,
    channelHandler,
    dispatcherOptions: host,
    //thread,
    //debugSignal: debug?.logMain ?? false,
    //perf,
  });

  channelHandler.open(check);

  let worker: SpawnedWorker;

  const workerUrl = source ?? (
    // isBrowser
    //   ? tsFileUrl.href // correct in browser
    //   :
    tsFileUrl
  );
  const workerDataPayload = {
    sab: signals.sab,
    abortSignalSAB,
    abortSignalMax: usesAbortSignal === true
      ? resolvedAbortSignalCapacity
      : undefined,
    list,
    ids,
    at,
    thread,
    debug,
    workerOptions,
    totalNumberOfThread,
    startAt: signalBox.startAt,
    lock: lockBuffers,
    returnLock: returnLockBuffers,
    payloadConfig: resolvedPayloadConfig,
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
    resourceLimits?: NodeWorkerResourceLimits;
  };
  const nodeResourceLimits = toNodeWorkerResourceLimits(
    workerOptions?.resourceLimits,
  );
  const baseNodeWorkerOptions = nodeResourceLimits
    ? { ...baseWorkerOptions, resourceLimits: nodeResourceLimits }
    : baseWorkerOptions;
  const withExecArgv = workerExecArgv && workerExecArgv.length > 0
    ? { ...baseNodeWorkerOptions, execArgv: workerExecArgv }
    : baseNodeWorkerOptions;
  try {
    worker = new poliWorker(workerUrl, withExecArgv) as Worker;
  } catch (error) {
    if ((error as { code?: string })?.code === "ERR_WORKER_INVALID_EXEC_ARGV") {
      const fallbackExecArgv = toWorkerSafeExecArgv(withExecArgv.execArgv);
      if (fallbackExecArgv && fallbackExecArgv.length > 0) {
        try {
          worker = new poliWorker(
            workerUrl,
            { ...baseNodeWorkerOptions, execArgv: fallbackExecArgv },
          ) as Worker;
        } catch (fallbackError) {
          if (
            (fallbackError as { code?: string })?.code ===
              "ERR_WORKER_INVALID_EXEC_ARGV"
          ) {
            const compatExecArgv = toWorkerCompatExecArgv(fallbackExecArgv);
            if (compatExecArgv && compatExecArgv.length > 0) {
              try {
                worker = new poliWorker(
                  workerUrl,
                  { ...baseNodeWorkerOptions, execArgv: compatExecArgv },
                ) as Worker;
              } catch {
                worker = new poliWorker(
                  workerUrl,
                  baseNodeWorkerOptions,
                ) as Worker;
              }
            } else {
              worker = new poliWorker(
                workerUrl,
                baseNodeWorkerOptions,
              ) as Worker;
            }
          } else {
            throw fallbackError;
          }
        }
      } else {
        worker = new poliWorker(workerUrl, baseNodeWorkerOptions) as Worker;
      }
    } else {
      throw error;
    }
  }

  let closedReason: string | undefined;
  const markWorkerClosed = (reason: string): void => {
    if (closedReason) return;
    closedReason = reason;
    rejectAll(reason);
    channelHandler.close();
  };

  const nodeWorker = worker as unknown as NodeWorkerLike;
  nodeWorker.on?.("message", (message: unknown) => {
    if (!isWorkerFatalMessage(message)) return;
    markWorkerClosed(
      `Worker startup failed: ${message[WORKER_FATAL_MESSAGE_KEY]}`,
    );
    terminateWorkerQuietly(worker);
  });
  nodeWorker.on?.("error", (error: unknown) => {
    const message = String((error as { message?: unknown })?.message ?? error);
    markWorkerClosed(`Worker crashed: ${message}`);
  });
  nodeWorker.on?.("exit", (code: unknown) => {
    if (typeof code === "number" && code === 0) return;
    const normalized = typeof code === "number" ? code : -1;
    markWorkerClosed(`Worker exited with code ${normalized}`);
  });

  const thisSignal = signalBox.opView;
  const a_add = Atomics.add;
  const a_load = Atomics.load;
  const a_notify = Atomics.notify;
  //const scheduleFastCheck = queueMicrotask;

  const send = () => {
    if (check.isRunning === true) return;
    check.isRunning = true;
    Promise.resolve().then(check);
    // Macro lane: dispatcher check is driven by the channel callback.
    // channelHandler.notify();

    // Use opView as a wake counter in lock2 mode to avoid lost wakeups.
    if (a_load(signalBox.rxStatus, 0) === 0) {
      a_add(thisSignal, 0, 1);
      a_notify(thisSignal, 0, 1);
    }
  };

  lock.setPromiseHandler((task: Task) => {
    queue.settlePromisePayload(task);
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

  const context: WorkerContext & { lock: Lock2 } = {
    txIdle,
    call,
    kills: async () => {
      markWorkerClosed("Thread closed");
      try {
        void Promise.resolve(worker.terminate()).catch(() => {});
      } catch {
      }
    },
    lock,
  };

  return context;
};

export type CreateContext = WorkerContext;
