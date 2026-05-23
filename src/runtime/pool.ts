// main.ts

import { fileURLToPath as fileURLToPathCompat } from "node:url";
import { createHostTxQueue } from "./tx-queue.ts";
import {
  createSharedMemoryTransport,
  type Sab,
  TRANSPORT_SIGNAL_BYTES,
} from "../ipc/transport/shared-memory.ts";
import { ChannelHandler, hostDispatcherLoop } from "./dispatcher.ts";
import {
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  type Task,
} from "../memory/lock.ts";
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
  RUNTIME,
} from "../common/runtime.ts";
import {
  HAS_NODE_WORKER_THREADS,
  RUNTIME_PROCESS_WORKER_BOOT_ENV,
  RUNTIME_PROCESS_WORKER_BOOT_VERSION,
  RUNTIME_PROCESS_WORKER_ENV,
  RUNTIME_WORKER,
  type RuntimeWorkerLike,
} from "../common/worker-runtime.ts";
import {
  toSharedBufferRegion,
  type SharedBufferSource,
} from "../common/shared-buffer-region.ts";
import { probeLockBufferTextCompat } from "../common/shared-buffer-text.ts";
import { signalAbortFactory } from "../shared/abortSignal.ts";
import {
  createByteCarpet,
  createLockControlCarpet,
  getHeaderBlockByteLength,
  makeSharedBufferRegion,
  type ByteCarpetSlice,
  type LockControlCarpet,
} from "../memory/byte-carpet.ts";
import {
  type PayloadBufferOptions,
  resolvePayloadBufferOptions,
} from "../memory/payload-config.ts";
import {
  getNodeBuiltinModule,
  getNodeProcess,
} from "../common/node-compat.ts";
import { createBunConnectionPrimitives } from "../connections/bun.ts";
import { createDenoConnectionPrimitives } from "../connections/deno.ts";
import {
  FileDescriptor,
  ProcessSharedBuffer,
  type ProcessSharedBufferMetadata,
} from "../connections/index.ts";
import {
  createNodeConnectionPrimitives,
  loadNodeFutexAddon,
} from "../connections/node.ts";
import { loadNodeNativeAddon } from "../connections/node-addons.ts";
import { detectPosixPlatform } from "../connections/posix.ts";
import type {
  SharedMemoryBuffer,
  SharedMemoryMapping,
} from "../connections/types.ts";

type SpawnedWorker = {
  terminate: () => unknown;
  unref?: () => unknown;
  postMessage?: (message: unknown) => void;
};

type NodeWorkerLike = {
  on?: (
    event: "error" | "exit" | "message",
    listener: (...args: unknown[]) => void,
  ) => void;
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
type BunSubprocessLike = {
  exited: Promise<number>;
  kill: (signal?: string | number) => unknown;
  send?: (message: unknown) => void;
};
type BunSpawnOptions = {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: "ignore" | "inherit" | "pipe" | number | null;
  stdout?: "ignore" | "inherit" | "pipe" | number | null;
  stderr?: "ignore" | "inherit" | "pipe" | number | null;
  ipc?: (message: unknown, subprocess: BunSubprocessLike) => void;
  serialization?: "advanced" | "json";
  onExit?: (
    subprocess: BunSubprocessLike,
    exitCode: number | null,
    signalCode: number | null,
    error?: unknown,
  ) => void;
};
type BunRuntimeLike = {
  argv?: string[];
  spawn?: (options: BunSpawnOptions) => BunSubprocessLike;
};
type NodeChildProcessLike = {
  kill: (signal?: string | number) => unknown;
  send?: (message: unknown) => void;
  unref?: () => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};
type NodeChildProcessModuleLike = {
  spawn: (
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown>,
  ) => NodeChildProcessLike;
};
type DenoFsFileLike = {
  close?: () => void;
  [key: symbol]: unknown;
};
type DenoCommandChildLike = {
  status: Promise<{ code: number; signal: string | null; success: boolean }>;
  kill: (signal?: string) => void;
};
type DenoCommandConstructorLike = new (
  command: string,
  options?: Record<string, unknown>,
) => {
  spawn: () => DenoCommandChildLike;
};
type DenoRuntimeLike = {
  Command?: DenoCommandConstructorLike;
  cwd?: () => string;
  execPath?: () => string;
  openSync?: (
    path: string,
    options: { read?: boolean; write?: boolean },
  ) => DenoFsFileLike;
};
type ProcessWorkerMemoryLayout = {
  mapping: SharedMemoryMapping<SharedMemoryBuffer>;
  descriptor: FileDescriptor;
  controlLayout: LockControlCarpet;
  lockPayload: SharedBufferSource;
  returnPayload: SharedBufferSource;
};
type ProcessWorkerRuntime = NonNullable<WorkerSettings["processRuntime"]>;
type ProcessWorkerCommandPrefix = NonNullable<
  WorkerSettings["processCommandPrefix"]
>;
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

type NodeModuleBuiltin = {
  createRequire: (url: string) => (specifier: string) => unknown;
};

type ProcessSharedMemoryNativeMapping = {
  sab: SharedArrayBuffer;
  fd: number;
  size: number;
  baseAddressMod64?: number;
};

type ProcessSharedMemoryAddon = {
  createSharedMemory: (size: number) => ProcessSharedMemoryNativeMapping;
};

type ProcessSharedMemoryBacking = ProcessSharedMemoryNativeMapping & {
  runtime: "node";
  buffer: SharedArrayBuffer;
  kind: "shared-array-buffer";
  byteLength: number;
};

type ProcessSharedMemoryAllocator = {
  createBuffer: (byteLength: number) => SharedArrayBuffer;
  backings: ProcessSharedMemoryBacking[];
};

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

const toProcessSharedMemorySize = (byteLength: number): number => {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new RangeError("process shared memory byteLength must be positive");
  }
  const size = Math.trunc(byteLength);
  return size + ((64 - (size % 64)) % 64);
};

const createProcessSharedMemoryAllocator = (
  debug: DebugOptions | undefined,
): ProcessSharedMemoryAllocator | undefined => {
  if (RUNTIME !== "node") return undefined;

  let addon: ProcessSharedMemoryAddon;
  try {
    const nodeModule = getNodeBuiltinModule<NodeModuleBuiltin>("node:module");
    if (nodeModule === undefined) return undefined;

    const require = nodeModule.createRequire(import.meta.url);
    addon = loadNodeNativeAddon<ProcessSharedMemoryAddon>(
      require,
      "knitting_shared_memory",
    );
  } catch (error) {
    if (debug?.extras === true) {
      console.warn(
        "Process-shared memory allocator unavailable; falling back to SharedArrayBuffer.",
        error,
      );
    }
    return undefined;
  }

  const backings: ProcessSharedMemoryBacking[] = [];
  return {
    backings,
    createBuffer: (byteLength: number): SharedArrayBuffer => {
      const mapping = addon.createSharedMemory(
        toProcessSharedMemorySize(byteLength),
      );
      backings.push({
        ...mapping,
        runtime: "node",
        buffer: mapping.sab,
        kind: "shared-array-buffer",
        byteLength: mapping.sab.byteLength,
      });
      return mapping.sab;
    },
  };
};

const PROCESS_WORKER_CHILD_FD = 0;
const DEFAULT_BUN_BINARY = "bun";
const DEFAULT_DENO_BINARY = "deno";
const DEFAULT_NODE_BINARY = "node";
const DENO_PROCESS_WORKER_BOOT_ENV_ALLOW = [
  RUNTIME_PROCESS_WORKER_ENV,
  RUNTIME_PROCESS_WORKER_BOOT_ENV,
].join(",");
const DENO_PROCESS_WORKER_INTERNAL_FLAGS = [
  `--allow-env=${DENO_PROCESS_WORKER_BOOT_ENV_ALLOW}`,
  "--allow-ffi",
];
const NODE_PROCESS_WORKER_EXEC_ARGV = [
  "--no-warnings",
  "--experimental-transform-types",
];

const withFixedPayloadConfig = (
  config: ReturnType<typeof resolvePayloadBufferOptions>,
): ReturnType<typeof resolvePayloadBufferOptions> => ({
  ...config,
  mode: "fixed",
  payloadInitialBytes: config.payloadMaxByteLength,
});

const getProcessWorkerSharedMemoryPrimitives = () => {
  switch (RUNTIME) {
    case "bun":
      return createBunConnectionPrimitives();
    case "deno":
      return createDenoConnectionPrimitives();
    case "node":
      return createNodeConnectionPrimitives();
    default:
      throw new Error(
        "process worker runtime needs Node, Deno, or Bun shared memory primitives",
      );
  }
};

const createProcessWorkerMemoryLayout = ({
  signalBytes,
  abortBytes,
  payloadBytes,
  thread,
}: {
  signalBytes: number;
  abortBytes: number;
  payloadBytes: number;
  thread: number;
}): ProcessWorkerMemoryLayout => {
  const carpet = createByteCarpet();
  const signalsSlice = carpet.take("signals", signalBytes);
  const requestLockSlice = carpet.take(
    "requestLockSector",
    LOCK_SECTOR_BYTE_LENGTH,
  );
  const returnLockSlice = carpet.take(
    "returnLockSector",
    LOCK_SECTOR_BYTE_LENGTH,
  );
  const requestHeadersSlice = carpet.take(
    "requestHeaders",
    getHeaderBlockByteLength({
      slotCount: LockBound.slots,
      slotStrideU32: HEADER_SLOT_STRIDE_U32,
      alignTo: 64,
    }),
  );
  const returnHeadersSlice = carpet.take(
    "returnHeaders",
    getHeaderBlockByteLength({
      slotCount: LockBound.slots,
      slotStrideU32: HEADER_SLOT_STRIDE_U32,
      alignTo: 64,
    }),
  );
  const abortSignalsSlice = carpet.take("abortSignals", abortBytes);
  const requestPayloadSlice = carpet.take("requestPayload", payloadBytes);
  const returnPayloadSlice = carpet.take("returnPayload", payloadBytes);

  const primitives = getProcessWorkerSharedMemoryPrimitives();
  const mapping = primitives.createSharedMemory({
    size: carpet.byteLength(),
    name: `knitting_process_worker_${thread}`,
  });
  const buffer = mapping.buffer;
  const bind = (slice: ByteCarpetSlice) =>
    makeSharedBufferRegion(buffer, slice.byteOffset, slice.byteLength);
  const controlLayout: LockControlCarpet = {
    controlSAB: buffer,
    signals: bind(signalsSlice),
    abortSignals: bind(abortSignalsSlice),
    lock: {
      headers: bind(requestHeadersSlice),
      headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
      lockSector: bind(requestLockSlice),
      payloadSector: bind(requestLockSlice),
    },
    returnLock: {
      headers: bind(returnHeadersSlice),
      headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
      lockSector: bind(returnLockSlice),
      payloadSector: bind(returnLockSlice),
    },
    slices: carpet.slices,
  };

  return {
    mapping,
    descriptor: FileDescriptor.fromMapping(mapping),
    controlLayout,
    lockPayload: bind(requestPayloadSlice),
    returnPayload: bind(returnPayloadSlice),
  };
};

const toChildProcessSharedBufferMetadata = (
  source: SharedBufferSource,
  descriptor: FileDescriptor,
): ProcessSharedBufferMetadata => {
  const region = toSharedBufferRegion(source);
  return ProcessSharedBuffer.fromDescriptor(
    new FileDescriptor({
      ...descriptor.toMetadata(),
      fd: PROCESS_WORKER_CHILD_FD,
    }),
    {
      byteOffset: region.byteOffset,
      byteLength: region.byteLength,
    },
  ).toMetadata();
};

const toProcessWorkerWireLockBuffers = (
  lock: LockBuffers,
  descriptor: FileDescriptor,
): ProcessWorkerWireLockBuffers => ({
  ...lock,
  headers: toChildProcessSharedBufferMetadata(lock.headers, descriptor),
  lockSector: toChildProcessSharedBufferMetadata(lock.lockSector, descriptor),
  payload: toChildProcessSharedBufferMetadata(lock.payload, descriptor),
  payloadSector: toChildProcessSharedBufferMetadata(
    lock.payloadSector,
    descriptor,
  ),
});

const toProcessWorkerBootPayload = (
  workerData: WorkerData,
  memory: ProcessWorkerMemoryLayout,
): ProcessWorkerBootPayload => ({
  version: RUNTIME_PROCESS_WORKER_BOOT_VERSION,
  workerData: {
    ...workerData,
    sab: toChildProcessSharedBufferMetadata(workerData.sab, memory.descriptor),
    abortSignalSAB: workerData.abortSignalSAB === undefined
      ? undefined
      : toChildProcessSharedBufferMetadata(
        workerData.abortSignalSAB,
        memory.descriptor,
      ),
    lock: toProcessWorkerWireLockBuffers(workerData.lock, memory.descriptor),
    returnLock: toProcessWorkerWireLockBuffers(
      workerData.returnLock,
      memory.descriptor,
    ),
  },
});

const toProcessWorkerPath = (specifier: string | URL): string => {
  const value = specifier instanceof URL ? specifier.href : specifier;
  if (value.startsWith("file:")) return fileURLToPathCompat(value);
  return value;
};

const readProcessWorkerRuntime = (
  options: WorkerSettings | undefined,
): ProcessWorkerRuntime => {
  const runtime = options?.processRuntime ?? "bun";
  if (runtime === "bun" || runtime === "deno" || runtime === "node") {
    return runtime;
  }
  throw new TypeError(`Unsupported process worker runtime: ${String(runtime)}`);
};

const readProcessWorkerCommandPrefix = (
  options: WorkerSettings | undefined,
): ProcessWorkerCommandPrefix | undefined => {
  const prefix = options?.processCommandPrefix;
  if (prefix === undefined) return undefined;
  if (!Array.isArray(prefix)) {
    throw new TypeError("processCommandPrefix must be an argv array");
  }
  if (prefix.length === 0) return undefined;

  const out: string[] = [];
  for (const [index, value] of prefix.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(
        `processCommandPrefix[${index}] must be a non-empty string`,
      );
    }
    out.push(value);
  }
  return out;
};

const currentProcessEnv = (): Record<string, string | undefined> => ({
  ...getNodeProcess()?.env,
});

const processWorkerEnv = (
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> => ({
  ...currentProcessEnv(),
  [RUNTIME_PROCESS_WORKER_ENV]: "1",
  ...extra,
});

const processWorkerBootEnv = (
  bootPayload: ProcessWorkerBootPayload,
): Record<string, string | undefined> =>
  processWorkerEnv({
    [RUNTIME_PROCESS_WORKER_BOOT_ENV]: JSON.stringify(bootPayload),
  });

const stringProcessEnv = (
  input: Record<string, string | undefined>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const processWorkerBunBinary = (bun?: BunRuntimeLike): string =>
  getNodeProcess()?.env?.BUN_BINARY ??
  bun?.argv?.[0] ??
  DEFAULT_BUN_BINARY;

const processWorkerDenoBinary = (deno?: DenoRuntimeLike): string =>
  getNodeProcess()?.env?.DENO_BINARY ??
  deno?.execPath?.() ??
  DEFAULT_DENO_BINARY;

const processWorkerDenoFlags = (
  permission: WorkerData["permission"] | undefined,
): string[] => {
  if (permission?.enabled !== true || permission.unsafe === true) {
    return ["-A"];
  }
  return [
    ...DENO_PROCESS_WORKER_INTERNAL_FLAGS,
    ...permission.deno.flags,
  ];
};

const processWorkerNodeBinary = (): string => {
  const nodeProcess = getNodeProcess();
  return nodeProcess?.env?.NODE_BINARY ??
    (RUNTIME === "node" ? nodeProcess?.execPath : undefined) ??
    DEFAULT_NODE_BINARY;
};

const processWorkerNodeExecArgv = (): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (flag: string) => {
    if (seen.has(flag)) return;
    seen.add(flag);
    out.push(flag);
  };

  for (const flag of toWorkerCompatExecArgv(getNodeProcess()?.execArgv) ?? []) {
    add(flag);
  }
  for (const flag of NODE_PROCESS_WORKER_EXEC_ARGV) add(flag);
  return out;
};

const processWorkerCommand = ({
  processRuntime,
  workerUrl,
  bun,
  deno,
  commandPrefix,
  permission,
}: {
  processRuntime: ProcessWorkerRuntime;
  workerUrl: string | URL;
  bun?: BunRuntimeLike;
  deno?: DenoRuntimeLike;
  commandPrefix?: ProcessWorkerCommandPrefix;
  permission?: WorkerData["permission"];
}): [string, ...string[]] => {
  const workerPath = toProcessWorkerPath(workerUrl);
  let command: [string, ...string[]];
  if (processRuntime === "deno") {
    command = [
      processWorkerDenoBinary(deno),
      "run",
      ...processWorkerDenoFlags(permission),
      workerPath,
    ];
  } else if (processRuntime === "node") {
    command = [
      processWorkerNodeBinary(),
      ...processWorkerNodeExecArgv(),
      workerPath,
    ];
  } else {
    command = [processWorkerBunBinary(bun), workerPath];
  }

  return commandPrefix === undefined
    ? command
    : [...commandPrefix, ...command] as [string, ...string[]];
};

const createProcessWorkerNativeSignalNotifier = ({
  processRuntime,
  signal,
}: {
  processRuntime: ProcessWorkerRuntime | undefined;
  signal: Int32Array;
}): (() => void) | undefined => {
  if (RUNTIME !== "node" || processRuntime !== "node") return undefined;

  try {
    const futex = loadNodeFutexAddon();
    return () => {
      futex.wakeU32(signal.buffer, signal.byteOffset, 1);
    };
  } catch {
    return undefined;
  }
};

const createProcessWorkerEventHub = () => {
  const messageHandlers: Array<(message: unknown) => void> = [];
  const errorHandlers: Array<(error: unknown) => void> = [];
  const exitHandlers: Array<(code: unknown) => void> = [];

  return {
    emitMessage: (message: unknown) => {
      for (const handler of messageHandlers) handler(message);
    },
    emitError: (error: unknown) => {
      for (const handler of errorHandlers) handler(error);
    },
    emitExit: (code: unknown) => {
      for (const handler of exitHandlers) handler(code);
    },
    on: (event: "error" | "exit" | "message", listener: (...args: unknown[]) => void) => {
      if (event === "message") messageHandlers.push(listener);
      if (event === "error") errorHandlers.push(listener);
      if (event === "exit") exitHandlers.push(listener);
    },
  };
};

const spawnBunHostedProcessWorker = ({
  workerUrl,
  bootPayload,
  memory,
  processRuntime,
  commandPrefix,
  permission,
}: {
  workerUrl: string | URL;
  bootPayload: ProcessWorkerBootPayload;
  memory: ProcessWorkerMemoryLayout;
  processRuntime: ProcessWorkerRuntime;
  commandPrefix?: ProcessWorkerCommandPrefix;
  permission?: WorkerData["permission"];
}): SpawnedWorker & NodeWorkerLike => {
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntimeLike }).Bun;
  if (typeof bun?.spawn !== "function") {
    throw new Error("Bun.spawn is not available for process workers");
  }

  const events = createProcessWorkerEventHub();
  const nodeProcess = getNodeProcess();
  const useIpcBoot = processRuntime === "bun" && commandPrefix === undefined;
  const spawnOptions: BunSpawnOptions = {
    cmd: processWorkerCommand({
      processRuntime,
      workerUrl,
      bun,
      commandPrefix,
      permission,
    }),
    cwd: nodeProcess?.cwd?.(),
    env: useIpcBoot
      ? processWorkerEnv()
      : processWorkerBootEnv(bootPayload),
    stdin: memory.mapping.fd,
    stdout: "inherit",
    stderr: "inherit",
    onExit: (_subprocess, exitCode, _signalCode, error) => {
      if (error !== undefined) events.emitError(error);
      events.emitExit(exitCode ?? -1);
    },
  };

  if (useIpcBoot) {
    spawnOptions.serialization = "advanced";
    spawnOptions.ipc = (message) => {
      events.emitMessage(message);
    };
  }

  const child = bun.spawn(spawnOptions);

  if (useIpcBoot) {
    queueMicrotask(() => child.send?.(bootPayload));
  }
  child.exited.catch((error) => {
    events.emitError(error);
  });

  return {
    terminate: () => {
      child.kill();
      return child.exited.catch(() => undefined);
    },
    on: events.on,
  };
};

const spawnNodeHostedProcessWorker = ({
  workerUrl,
  bootPayload,
  memory,
  processRuntime,
  commandPrefix,
  permission,
}: {
  workerUrl: string | URL;
  bootPayload: ProcessWorkerBootPayload;
  memory: ProcessWorkerMemoryLayout;
  processRuntime: ProcessWorkerRuntime;
  commandPrefix?: ProcessWorkerCommandPrefix;
  permission?: WorkerData["permission"];
}): SpawnedWorker & NodeWorkerLike => {
  const childProcess =
    getNodeBuiltinModule<NodeChildProcessModuleLike>("node:child_process");
  if (typeof childProcess?.spawn !== "function") {
    throw new Error("node:child_process.spawn is not available");
  }

  const events = createProcessWorkerEventHub();
  const useIpcBoot = processRuntime === "bun" && commandPrefix === undefined;
  const [command, ...args] = processWorkerCommand({
    processRuntime,
    workerUrl,
    commandPrefix,
    permission,
  });
  const child = childProcess.spawn(
    command,
    args,
    {
      cwd: getNodeProcess()?.cwd?.(),
      env: useIpcBoot
        ? processWorkerEnv()
        : processWorkerBootEnv(bootPayload),
      stdio: useIpcBoot
        ? [memory.mapping.fd, "inherit", "inherit", "ipc"]
        : [memory.mapping.fd, "inherit", "inherit"],
    },
  );

  if (useIpcBoot) {
    child.on("message", events.emitMessage);
    queueMicrotask(() => child.send?.(bootPayload));
  }
  child.on("error", events.emitError);
  child.on("exit", (code) => events.emitExit(code ?? -1));

  return {
    terminate: () => child.kill(),
    unref: () => child.unref?.(),
    on: events.on,
  };
};

const getDenoRuntime = (): DenoRuntimeLike | undefined =>
  (globalThis as typeof globalThis & { Deno?: DenoRuntimeLike }).Deno;

const denoFileRid = (file: DenoFsFileLike): number => {
  for (const symbol of Object.getOwnPropertySymbols(file)) {
    if (String(symbol) === "Symbol(Deno.internal.rid)") {
      const rid = file[symbol];
      if (typeof rid === "number") return rid;
    }
  }
  throw new Error("Deno FsFile resource id is not available");
};

const openDenoInheritedFd = (fd: number): DenoFsFileLike => {
  const deno = getDenoRuntime();
  if (typeof deno?.openSync !== "function") {
    throw new Error("Deno.openSync is not available for process workers");
  }
  const fdPath = detectPosixPlatform() === "linux"
    ? `/proc/self/fd/${fd}`
    : `/dev/fd/${fd}`;
  return deno.openSync(fdPath, { read: true, write: true });
};

const spawnDenoHostedProcessWorker = ({
  workerUrl,
  bootPayload,
  memory,
  processRuntime,
  commandPrefix,
  permission,
}: {
  workerUrl: string | URL;
  bootPayload: ProcessWorkerBootPayload;
  memory: ProcessWorkerMemoryLayout;
  processRuntime: ProcessWorkerRuntime;
  commandPrefix?: ProcessWorkerCommandPrefix;
  permission?: WorkerData["permission"];
}): SpawnedWorker & NodeWorkerLike => {
  const deno = getDenoRuntime();
  if (typeof deno?.Command !== "function") {
    throw new Error("Deno.Command is not available for process workers");
  }

  const inheritedFd = openDenoInheritedFd(memory.mapping.fd);
  const events = createProcessWorkerEventHub();
  const [command, ...args] = processWorkerCommand({
    processRuntime,
    workerUrl,
    deno,
    commandPrefix,
    permission,
  });
  const child = new deno.Command(command, {
    args,
    cwd: deno.cwd?.(),
    env: stringProcessEnv(processWorkerBootEnv(bootPayload)),
    stdin: denoFileRid(inheritedFd),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const closeInheritedFd = () => {
    try {
      inheritedFd.close?.();
    } catch {
    }
  };

  child.status.then(
    (status) => {
      closeInheritedFd();
      events.emitExit(status.code);
    },
    (error) => {
      closeInheritedFd();
      events.emitError(error);
      events.emitExit(-1);
    },
  );

  return {
    terminate: () => {
      try {
        child.kill("SIGTERM");
      } catch {
      }
      return child.status.finally(closeInheritedFd);
    },
    on: events.on,
  };
};

const spawnProcessWorker = (
  options: {
    workerUrl: string | URL;
    bootPayload: ProcessWorkerBootPayload;
    memory: ProcessWorkerMemoryLayout;
    processRuntime: ProcessWorkerRuntime;
    commandPrefix?: ProcessWorkerCommandPrefix;
    permission?: WorkerData["permission"];
  },
): SpawnedWorker & NodeWorkerLike => {
  switch (RUNTIME) {
    case "bun":
      return spawnBunHostedProcessWorker(options);
    case "node":
      return spawnNodeHostedProcessWorker(options);
    case "deno":
      return spawnDenoHostedProcessWorker(options);
    default:
      throw new Error("process worker runtime is only available in Node, Deno, or Bun");
  }
};

const terminateWorkerQuietly = (worker: SpawnedWorker): void => {
  try {
    // Runaway worker termination can be slow or stuck on some runtimes; once the
    // pool is closing it must not keep the host process alive.
    worker.unref?.();
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
  const poliWorker = RUNTIME_WORKER;
  const resolvedWorkerOptions = withDefaultWorkerTimers(workerOptions);
  const useProcessWorkerRuntime = resolvedWorkerOptions.runtime === "process";
  const processWorkerRuntime = useProcessWorkerRuntime
    ? readProcessWorkerRuntime(resolvedWorkerOptions)
    : undefined;
  const processWorkerCommandPrefix = useProcessWorkerRuntime
    ? readProcessWorkerCommandPrefix(resolvedWorkerOptions)
    : undefined;

  if (debug?.logHref === true) {
    console.log(tsFileUrl);
  }
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
    throw new Error("process worker runtime cannot use an external signal buffer");
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
  });
  const returnLock = lock2({
    headers: returnLockBuffers.headers,
    headerSlotStrideU32: returnLockBuffers.headerSlotStrideU32,
    LockBoundSector: returnLockBuffers.lockSector,
    payload: returnLockBuffers.payload,
    payloadSector: returnLockBuffers.payloadSector,
    payloadConfig: resolvedPayloadConfig,
    textCompat: returnLockBuffers.textCompat,
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
  const nativeNotifySignal = createProcessWorkerNativeSignalNotifier({
    processRuntime: processWorkerRuntime,
    signal: signalBox.opView,
  });

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
    notifySignal: nativeNotifySignal,
    //thread,
    //debugSignal: debug?.logMain ?? false,
    //perf,
  });

  channelHandler.open(check);

  let worker: SpawnedWorker;

  const workerUrl = source ?? tsFileUrl;
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
    workerOptions: resolvedWorkerOptions,
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
  const markWorkerClosed = (reason: string): void => {
    if (closedReason) return;
    closedReason = reason;
    rejectAll(reason);
    channelHandler.close();
  };

  const onWorkerMessage = (message: unknown) => {
    if (!isWorkerFatalMessage(message)) return;
    markWorkerClosed(
      `Worker startup failed: ${message[WORKER_FATAL_MESSAGE_KEY]}`,
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

  const thisSignal = signalBox.opView;
  const a_add = Atomics.add;
  const a_load = Atomics.load;
  const a_notify = Atomics.notify;
  const canNotifySignal = thisSignal.buffer instanceof SharedArrayBuffer;
  const notifySignal = nativeNotifySignal ??
    (canNotifySignal ? (() => a_notify(thisSignal, 0, 1)) : undefined);
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
      notifySignal?.();
    }
  };

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
  } = {
    txIdle,
    call,
    kills: async () => {
      markWorkerClosed("Thread closed");
      terminateWorkerQuietly(worker);
    },
    lock,
    processSharedMemoryBackings: processSharedMemory?.backings,
  };

  return context;
};

export type CreateContext = WorkerContext;
