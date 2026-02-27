// main.ts

import { createHostTxQueue } from "./tx-queue.ts";
import {
  createSharedMemoryTransport,
  type Sab,
} from "../ipc/transport/shared-memory.ts";
import { ChannelHandler, hostDispatcherLoop } from "./dispatcher.ts";
import {
  HEADER_BYTE_LENGTH,
  LOCK_SECTOR_BYTE_LENGTH,
  lock2,
  type PromisePayloadResult,
  type Task,
} from "../memory/lock.ts";
import type {
  DebugOptions,
  DispatcherSettings,
  LockBuffers,
  WorkerResourceLimits,
  WorkerCall,
  WorkerContext,
  WorkerData,
  WorkerSettings,
} from "../types.ts";
import { jsrIsGreatAndWorkWithoutBugs } from "../worker/loop.ts";
import {
  HAS_SAB_GROW,
  IS_DENO,
  createSharedArrayBuffer,
} from "../common/runtime.ts";
import { signalAbortFactory } from "../shared/abortSignal.ts";
import { Worker } from "node:worker_threads";

//const isBrowser = typeof window !== "undefined";

let poliWorker = Worker;
const TX_STATUS_HINT_INDEX = 0;

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

type WebWorkerLike = {
  addEventListener?: (
    type: "error" | "message",
    listener: (event: { message?: unknown; error?: unknown; data?: unknown }) => void,
  ) => void;
};

type DenoPermissionValue = "inherit" | boolean | string[];

type DenoWorkerPermissions = {
  env?: DenoPermissionValue;
  ffi?: DenoPermissionValue;
  import?: DenoPermissionValue;
  net?: DenoPermissionValue;
  read?: DenoPermissionValue;
  run?: DenoPermissionValue;
  sys?: DenoPermissionValue;
  write?: DenoPermissionValue;
};

type DenoWorkerOptions = {
  type: "module";
  deno?: {
    permissions?: DenoWorkerPermissions;
  };
};

const DENO_WORKER_PERMISSIONS_ENV = "KNITTING_DENO_WORKER_PERMISSIONS";
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
  "--experimental-vm-modules",
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

const toWorkerSafeExecArgv = (flags: string[] | undefined): string[] | undefined => {
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

const toWorkerCompatExecArgv = (flags: string[] | undefined): string[] | undefined => {
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

const toNodeWorkerResourceLimits = (
  limits: WorkerResourceLimits | undefined,
): NodeWorkerResourceLimits | undefined => {
  if (!limits) return undefined;
  const out: NodeWorkerResourceLimits = {
    maxOldGenerationSizeMb: toPositiveInteger(limits.maxOldGenerationSizeMb),
    maxYoungGenerationSizeMb: toPositiveInteger(limits.maxYoungGenerationSizeMb),
    codeRangeSizeMb: toPositiveInteger(limits.codeRangeSizeMb),
    stackSizeMb: toPositiveInteger(limits.stackSizeMb),
  };
  return Object.values(out).some((value) => value !== undefined) ? out : undefined;
};

const toDenoWorkerPermissions = (
  protocol?: WorkerData["permission"],
): DenoWorkerPermissions | undefined => {
  if (!protocol || protocol.enabled !== true || protocol.unsafe === true) {
    return undefined;
  }
  const toScoped = (
    all: boolean,
    values: string[],
  ): DenoPermissionValue => all ? "inherit" : (values.length > 0 ? values : false);
  return {
    env: toScoped(protocol.env.allowAll, protocol.env.allow),
    ffi: toScoped(protocol.ffiAll, protocol.ffi),
    import: protocol.allowImport.length > 0 ? protocol.allowImport : false,
    net: toScoped(protocol.netAll, protocol.net),
    read: toScoped(protocol.readAll, protocol.read),
    run: toScoped(protocol.runAll, protocol.run),
    sys: toScoped(protocol.sysAll, protocol.sys),
    write: toScoped(protocol.writeAll, protocol.write),
  };
};

const readEnvFlag = (name: string): string | undefined => {
  try {
    if (typeof process !== "undefined" && typeof process.env === "object") {
      const value = process.env[name];
      if (typeof value === "string") return value;
    }
  } catch {
  }
  const g = globalThis as typeof globalThis & {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
  };
  try {
    const value = g.Deno?.env?.get?.(name);
    if (typeof value === "string") return value;
  } catch {
  }
  return undefined;
};

const parseEnvBool = (
  value: string | undefined,
): boolean | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
};

const hasDenoUnstableWorkerOptionsFlag = (): boolean => {
  const g = globalThis as typeof globalThis & {
    Deno?: { readTextFileSync?: (path: string) => string };
  };
  const readTextFileSync = g.Deno?.readTextFileSync;
  if (typeof readTextFileSync !== "function") return false;
  try {
    const cmdline = readTextFileSync("/proc/self/cmdline");
    if (!cmdline) return false;
    const args = cmdline.split("\u0000").filter((entry) => entry.length > 0);
    return args.some((arg) =>
      arg === "--unstable" ||
      arg === "--unstable-worker-options" ||
      arg.startsWith("--unstable=") && arg.includes("worker-options")
    );
  } catch {
    return false;
  }
};

const shouldUseDenoWorkerPermissions = (): boolean => {
  const envOverride = parseEnvBool(readEnvFlag(DENO_WORKER_PERMISSIONS_ENV));
  if (envOverride !== undefined) return envOverride;
  // Deno exits the process when Worker.deno.permissions is used without
  // --unstable-worker-options, so gate it behind best-effort flag detection.
  return hasDenoUnstableWorkerOptionsFlag();
};

const isUnstableDenoWorkerOptionsError = (error: unknown): boolean => {
  const message = String((error as { message?: unknown })?.message ?? error);
  return message.includes("unstable-worker-options") ||
    message.includes("Worker.deno.permissions");
};

const terminateWorkerQuietly = (worker: SpawnedWorker): void => {
  try {
    void Promise.resolve(worker.terminate()).catch(() => {});
  } catch {
  }
};

const toDenoWorkerScript = (source: string | URL, fallback: URL): string => {
  if (source instanceof URL) return source.href;
  try {
    return new URL(source, fallback).href;
  } catch {
    return source;
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
  castOnModule,
  castOnAt,
  workerOptions,
  workerExecArgv,
  permission,
  host,
  payloadInitialBytes,
  payloadMaxBytes,
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
  castOnModule?: string;
  castOnAt?: number;
  workerOptions?: WorkerSettings;
  workerExecArgv?: string[];
  permission?: WorkerData["permission"];
  host?: DispatcherSettings;
  payloadInitialBytes?: number;
  payloadMaxBytes?: number;
  abortSignalCapacity?: number;
  usesAbortSignal?: boolean;
}) => {
  const tsFileUrl = new URL(import.meta.url);

  if (debug?.logHref === true) {
    console.log(tsFileUrl);
    jsrIsGreatAndWorkWithoutBugs();
  }

  // Lock buffers must be shared between host and worker.
  const defaultPayloadMaxBytes = 64 * 1024 * 1024;
  const sanitizeBytes = (value: number | undefined) => {
    if (!Number.isFinite(value)) return undefined;
    const bytes = Math.floor(value as number);
    return bytes > 0 ? bytes : undefined;
  };
  const maxBytes = sanitizeBytes(payloadMaxBytes) ?? defaultPayloadMaxBytes;
  const requestedInitial = sanitizeBytes(payloadInitialBytes);
  const initialBytes = HAS_SAB_GROW
    ? Math.min(requestedInitial ?? (4 * 1024 * 1024), maxBytes)
    : maxBytes;
  const defaultAbortSignalCapacity = 258;
  const requestedAbortSignalCapacity = sanitizeBytes(abortSignalCapacity);
  const resolvedAbortSignalCapacity =
    requestedAbortSignalCapacity ?? defaultAbortSignalCapacity;

  const lockBuffers: LockBuffers = {
    lockSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
    payloadSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
    headers: new SharedArrayBuffer(HEADER_BYTE_LENGTH),
    payload: createSharedArrayBuffer(
      initialBytes,
      maxBytes,
    ),
  };
  const returnLockBuffers: LockBuffers = {
    lockSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
    payloadSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
    headers: new SharedArrayBuffer(HEADER_BYTE_LENGTH),
    payload: createSharedArrayBuffer(
      initialBytes,
      maxBytes,
    ),
  };

  const lock = lock2({
    headers: lockBuffers.headers,
    LockBoundSector: lockBuffers.lockSector,
    payload: lockBuffers.payload,
    payloadSector: lockBuffers.payloadSector,
  });
  const returnLock = lock2({
    headers: returnLockBuffers.headers,
    LockBoundSector: returnLockBuffers.lockSector,
    payload: returnLockBuffers.payload,
    payloadSector: returnLockBuffers.payloadSector,
  });
  const abortSignalWords = Math.max(
    1,
    Math.ceil(resolvedAbortSignalCapacity / 32),
  );
  const abortSignalSAB = usesAbortSignal === true
    ? new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT * abortSignalWords)
    : undefined;
  const abortSignals = abortSignalSAB
    ? signalAbortFactory({
      sab: abortSignalSAB,
      maxSignals: resolvedAbortSignalCapacity,
    })
    : undefined;

  const signals = createSharedMemoryTransport({
    sabObject: sab,
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

  const { check, fastCheck } = hostDispatcherLoop({
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
    abortSignalMax: usesAbortSignal === true ? resolvedAbortSignalCapacity : undefined,
    castOnModule,
    castOnAt,
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
  const webWorkerCtor = (globalThis as {
    Worker?: new (
      scriptURL: string | URL,
      options?: DenoWorkerOptions,
    ) => SpawnedWorker;
  }).Worker;
  const canUseDenoWebWorker = IS_DENO === true && typeof webWorkerCtor === "function";

  if (canUseDenoWebWorker) {
    const scriptURL = toDenoWorkerScript(workerUrl, tsFileUrl);
    const denoPermissions = shouldUseDenoWorkerPermissions()
      ? toDenoWorkerPermissions(permission)
      : undefined;
    const baseDenoOptions: DenoWorkerOptions = {
      type: "module",
    };
    const withPermissionOptions = denoPermissions
      ? {
        ...baseDenoOptions,
        deno: {
          permissions: denoPermissions,
        },
      }
      : baseDenoOptions;
    try {
      worker = new webWorkerCtor(scriptURL, withPermissionOptions);
    } catch (error) {
      if (!denoPermissions || !isUnstableDenoWorkerOptionsError(error)) {
        throw error;
      }
      worker = new webWorkerCtor(scriptURL, baseDenoOptions);
    }
    worker.postMessage?.(workerDataPayload);
  } else {
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
              (fallbackError as { code?: string })?.code === "ERR_WORKER_INVALID_EXEC_ARGV"
            ) {
              const compatExecArgv = toWorkerCompatExecArgv(fallbackExecArgv);
              if (compatExecArgv && compatExecArgv.length > 0) {
                try {
                  worker = new poliWorker(
                    workerUrl,
                    { ...baseNodeWorkerOptions, execArgv: compatExecArgv },
                  ) as Worker;
                } catch {
                  worker = new poliWorker(workerUrl, baseNodeWorkerOptions) as Worker;
                }
              } else {
                worker = new poliWorker(workerUrl, baseNodeWorkerOptions) as Worker;
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
  }

  let closedReason: string | undefined;
  const markWorkerClosed = (reason: string): void => {
    if (closedReason) return;
    closedReason = reason;
    rejectAll(reason);
    channelHandler.close();
  };

  const nodeWorker = worker as unknown as NodeWorkerLike;
  if (typeof nodeWorker.on === "function") {
    nodeWorker.on("message", (message: unknown) => {
      if (!isWorkerFatalMessage(message)) return;
      markWorkerClosed(
        `Worker startup failed: ${message[WORKER_FATAL_MESSAGE_KEY]}`,
      );
      terminateWorkerQuietly(worker);
    });
    nodeWorker.on("error", (error: unknown) => {
      const message = String((error as { message?: unknown })?.message ?? error);
      markWorkerClosed(`Worker crashed: ${message}`);
    });
    nodeWorker.on("exit", (code: unknown) => {
      if (typeof code === "number" && code === 0) return;
      const normalized = typeof code === "number" ? code : -1;
      markWorkerClosed(`Worker exited with code ${normalized}`);
    });
  } else {
    const webWorker = worker as unknown as WebWorkerLike;
    if (typeof webWorker.addEventListener === "function") {
      webWorker.addEventListener("message", (event) => {
        const data = event?.data;
        if (!isWorkerFatalMessage(data)) return;
        markWorkerClosed(
          `Worker startup failed: ${data[WORKER_FATAL_MESSAGE_KEY]}`,
        );
        terminateWorkerQuietly(worker);
      });
      webWorker.addEventListener("error", (event) => {
        const message = String(event?.message ?? event?.error ?? "worker error");
        markWorkerClosed(`Worker crashed: ${message}`);
      });
    }
  }

  const thisSignal = signalBox.opView;
  const a_add = Atomics.add;
  const a_load = Atomics.load;
  const a_notify = Atomics.notify;
  const scheduleFastCheck = queueMicrotask;

  const send = () => {
    if (check.isRunning === true) return;
    // Macro lane: dispatcher check is driven by the channel callback.
    channelHandler.notify();
    check.isRunning = true;

    // Use opView as a wake counter in lock2 mode to avoid lost wakeups.
    if (a_load(signalBox.rxStatus, 0) === 0) {
      a_add(thisSignal, 0, 1);
      a_notify(thisSignal, 0, 1);
    }
  };

  lock.setPromiseHandler((task: Task, result: PromisePayloadResult) => {
    queue.settlePromisePayload(task, result);
    send();
  });

  const call = ({ fnNumber, timeout, abortSignal }: WorkerCall) => {
    const enqueues = enqueue(fnNumber, timeout, abortSignal);

    return (args: Uint8Array) => {
      const pending = enqueues(args);

      if (fastCheck.isRunning === false) {
        // Prevent worker from sleeping before the dispatcher loop starts.
        // Best-effort hint only; non-atomic by design.
        signalBox.txStatus[TX_STATUS_HINT_INDEX] = 1;
        fastCheck.isRunning = true;
        scheduleFastCheck(fastCheck);
        send();
      }

      return pending;
    };
  };

  const context: WorkerContext & { lock: ReturnType<typeof lock2> } = {
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
