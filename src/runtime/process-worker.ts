import {
  HEADER_SLOT_STRIDE_U32,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
} from "../memory/lock.ts";
import {
  type ByteCarpetSlice,
  createByteCarpet,
  getHeaderBlockByteLength,
  type LockControlCarpet,
  makeSharedBufferRegion,
} from "../memory/byte-carpet.ts";
import type {
  DebugOptions,
  LockBuffers,
  WorkerData,
  WorkerSettings,
} from "../types.ts";
import { RUNTIME } from "../common/runtime.ts";
import { debugHas } from "../debug/gate.ts";
import {
  RUNTIME_POOL_DEPTH,
  RUNTIME_POOL_DEPTH_ENV,
  RUNTIME_PROCESS_WORKER_BOOT_ENV,
  RUNTIME_PROCESS_WORKER_BOOT_VERSION,
  RUNTIME_PROCESS_WORKER_ENV,
} from "../common/worker-runtime.ts";
import { getNodeBuiltinModule, getNodeProcess } from "../common/node-compat.ts";
import {
  type SharedBufferSource,
  toSharedBufferRegion,
} from "../common/shared-buffer-region.ts";
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

// `node:url` resolved lazily so this module evaluates on runtimes without it
// (e.g. Andromeda); process workers aren't used there, so it never runs.
const fileURLToPathCompat = (value: string): string => {
  const url = getNodeBuiltinModule<{ fileURLToPath: (u: string) => string }>(
    "node:url",
  );
  if (url === undefined) {
    throw new Error("node:url is not available in this runtime");
  }
  return url.fileURLToPath(value);
};

export type SpawnedWorker = {
  terminate: () => unknown;
  unref?: () => unknown;
  postMessage?: (message: unknown) => void;
};

export type NodeWorkerLike = {
  on?: (
    event: "error" | "exit" | "message",
    listener: (...args: unknown[]) => void,
  ) => void;
};

type ProcessWorkerWireLockBuffers =
  & Omit<
    LockBuffers,
    "headers" | "lockSector" | "payload" | "payloadSector"
  >
  & {
    headers: ProcessSharedBufferMetadata;
    lockSector: ProcessSharedBufferMetadata;
    payload: ProcessSharedBufferMetadata;
    payloadSector: ProcessSharedBufferMetadata;
  };

type ProcessWorkerWireData =
  & Omit<
    WorkerData,
    "sab" | "abortSignalSAB" | "lock" | "returnLock"
  >
  & {
    sab: ProcessSharedBufferMetadata;
    abortSignalSAB?: ProcessSharedBufferMetadata;
    lock: ProcessWorkerWireLockBuffers;
    returnLock: ProcessWorkerWireLockBuffers;
  };

export type ProcessWorkerBootPayload = {
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

export type ProcessWorkerMemoryLayout = {
  mapping: SharedMemoryMapping<SharedMemoryBuffer>;
  descriptor: FileDescriptor;
  controlLayout: LockControlCarpet;
  lockPayload: SharedBufferSource;
  returnPayload: SharedBufferSource;
  cleanup: () => void;
};

export type ProcessWorkerRuntime = NonNullable<
  WorkerSettings["processRuntime"]
>;
export type ProcessWorkerCommandPrefix = NonNullable<
  WorkerSettings["processCommandPrefix"]
>;
type ProcessSharedMemoryInput = NonNullable<
  WorkerSettings["processSharedMemory"]
>;

export type ResolvedProcessSharedMemorySettings = {
  mode: "inherit" | "named";
  namePrefix?: string;
  unlinkOnShutdown: boolean;
};

type NodeModuleBuiltin = {
  createRequire: (url: string) => (specifier: string) => unknown;
};

type ProcessSharedMemoryNativeMapping = {
  sab: SharedArrayBuffer;
  fd: number;
  name?: string;
  size: number;
  baseAddressMod64?: number;
};

type ProcessSharedMemoryAddon = {
  createSharedMemory: (size: number) => ProcessSharedMemoryNativeMapping;
};

export type ProcessSharedMemoryBacking = ProcessSharedMemoryNativeMapping & {
  runtime: "node";
  buffer: SharedArrayBuffer;
  kind: "shared-array-buffer";
  byteLength: number;
};

type ProcessSharedMemoryAllocator = {
  createBuffer: (byteLength: number) => SharedArrayBuffer;
  backings: ProcessSharedMemoryBacking[];
};

const execFlagKey = (flag: string): string => flag.split("=", 1)[0]!;
const NODE_PERMISSION_EXEC_FLAGS = new Set<string>([
  "--permission",
  "--experimental-permission",
  "--allow-fs-read",
  "--allow-fs-write",
  "--allow-worker",
  "--allow-child-process",
  "--allow-net",
  "--allow-addons",
  "--allow-ffi",
  "--allow-wasi",
]);
const NODE_WORKER_SAFE_EXEC_FLAGS = new Set<string>([
  "--experimental-ffi",
  "--experimental-transform-types",
  "--expose-gc",
  "--no-warnings",
  ...NODE_PERMISSION_EXEC_FLAGS,
]);

const isNodeWorkerSafeExecFlag = (flag: string): boolean =>
  NODE_WORKER_SAFE_EXEC_FLAGS.has(execFlagKey(flag));

const isNodePermissionExecFlag = (flag: string): boolean =>
  NODE_PERMISSION_EXEC_FLAGS.has(execFlagKey(flag));

export const toWorkerSafeExecArgv = (
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

export const toWorkerCompatExecArgv = (
  flags: string[] | undefined,
): string[] | undefined => {
  const safe = toWorkerSafeExecArgv(flags);
  if (!safe || safe.length === 0) return undefined;
  const compat = safe.filter((flag) => !isNodePermissionExecFlag(flag));
  return compat.length > 0 ? compat : undefined;
};

const toProcessSharedMemorySize = (byteLength: number): number => {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new RangeError("process shared memory byteLength must be positive");
  }
  const size = Math.trunc(byteLength);
  return size + ((64 - (size % 64)) % 64);
};

export const createProcessSharedMemoryAllocator = (
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
    if (debugHas(debug, "lifecycle")) {
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
  RUNTIME_POOL_DEPTH_ENV,
].join(",");
const DENO_PROCESS_WORKER_INTERNAL_FLAGS = [
  `--allow-env=${DENO_PROCESS_WORKER_BOOT_ENV_ALLOW}`,
  "--allow-ffi",
];
const nodeMajorVersion = (): number => {
  const version = getNodeProcess()?.versions?.node ?? "";
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  return Number.isInteger(major) ? major : 0;
};

const nodeProcessWorkerUsesFfi = (): boolean => {
  const major = nodeMajorVersion();
  return major >= 26 && major % 2 === 0;
};

const nodeProcessWorkerInternalExecArgv = (): string[] => {
  return [
    "--no-warnings",
    ...(nodeProcessWorkerUsesFfi()
      ? ["--experimental-ffi"]
      : ["--experimental-transform-types"]),
  ];
};

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

const processWorkerNeedsInheritedFd = (
  descriptor: FileDescriptor,
): boolean => descriptor.name === undefined;

const isWindowsRuntimeHost = (): boolean => {
  const denoOs = (globalThis as typeof globalThis & {
    Deno?: { build?: { os?: string } };
  }).Deno?.build?.os;
  if (denoOs !== undefined) return denoOs === "windows";

  return (globalThis as typeof globalThis & {
    process?: { platform?: string };
  }).process?.platform === "win32";
};

let processWorkerMemoryNameCounter = 0;

const makeProcessWorkerMemoryName = (
  thread: number,
  prefix = "kpw",
): string => {
  const processId = (globalThis as typeof globalThis & {
    process?: { pid?: number };
    Deno?: { pid?: number };
  }).process?.pid ??
    (globalThis as typeof globalThis & { Deno?: { pid?: number } }).Deno?.pid ??
    0;
  const next = processWorkerMemoryNameCounter++;
  // Keep total ≤ 30 chars: macOS POSIX shm_open limit is 31 including the leading /.
  const pidTag = Math.abs(processId).toString(36).slice(-4);
  const threadTag = (thread % 4096).toString(36);
  const nextTag = (next % 1296).toString(36);
  const randomTag = Math.random().toString(36).slice(2, 7);
  const safePrefix = (prefix.replace(/[^a-z0-9_-]/gi, "_") || "kpw").slice(0, 8);
  return `${safePrefix}_${pidTag}_${threadTag}_${nextTag}_${randomTag}`;
};

export const createProcessWorkerMemoryLayout = ({
  signalBytes,
  abortBytes,
  payloadBytes,
  thread,
  sharedMemory,
}: {
  signalBytes: number;
  abortBytes: number;
  payloadBytes: number;
  thread: number;
  sharedMemory: ResolvedProcessSharedMemorySettings;
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
  const forceNamed = sharedMemory.mode === "named" || isWindowsRuntimeHost();
  const mapping = primitives.createSharedMemory(
    forceNamed
      ? {
        size: carpet.byteLength(),
        mode: "create",
        name: makeProcessWorkerMemoryName(thread, sharedMemory.namePrefix),
      }
      : { size: carpet.byteLength() },
  );
  const descriptor = FileDescriptor.fromMapping(mapping);
  if (isWindowsRuntimeHost() && descriptor.name === undefined) {
    throw new Error(
      "Windows process worker shared memory must use a named mapping",
    );
  }
  if (sharedMemory.mode === "named" && descriptor.name === undefined) {
    throw new Error(
      "processSharedMemory mode named needs a named shared-memory backend",
    );
  }
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
    descriptor,
    controlLayout,
    lockPayload: bind(requestPayloadSlice),
    returnPayload: bind(returnPayloadSlice),
    cleanup: () => {
      const name = descriptor.name;
      if (name !== undefined && sharedMemory.unlinkOnShutdown) {
        primitives.unlinkSharedMemory?.(name);
      }
    },
  };
};

const toChildProcessSharedBufferMetadata = (
  source: SharedBufferSource,
  descriptor: FileDescriptor,
): ProcessSharedBufferMetadata => {
  const region = toSharedBufferRegion(source);
  const metadata = descriptor.toMetadata();
  const childMetadata = processWorkerNeedsInheritedFd(descriptor)
    ? { ...metadata, fd: PROCESS_WORKER_CHILD_FD }
    : metadata;

  return ProcessSharedBuffer.fromDescriptor(
    new FileDescriptor(childMetadata),
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

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const serializeWorkerBootstrapValue = (
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown => {
  if (value instanceof ProcessSharedBuffer) return value.toMetadata();
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) {
      out.push(serializeWorkerBootstrapValue(item, seen));
    }
    return out;
  }

  if (!isPlainRecord(value)) return value;

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    out[key] = serializeWorkerBootstrapValue(item, seen);
  }
  return out;
};

export const serializeWorkerBootstrapData = (
  options: WorkerSettings,
): WorkerSettings => {
  const bootstrap = options.bootstrap;
  if (bootstrap === undefined || bootstrap.data === undefined) return options;

  return {
    ...options,
    bootstrap: {
      ...bootstrap,
      data: serializeWorkerBootstrapValue(bootstrap.data),
    },
  };
};

export const toProcessWorkerBootPayload = (
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

export const readProcessWorkerRuntime = (
  options: WorkerSettings | undefined,
): ProcessWorkerRuntime => {
  const runtime = options?.processRuntime ?? "deno";
  if (runtime === "bun" || runtime === "deno" || runtime === "node") {
    return runtime;
  }
  throw new TypeError(`Unsupported process worker runtime: ${String(runtime)}`);
};

export const readProcessWorkerCommandPrefix = (
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

const readProcessSharedMemoryMode = (
  value: unknown,
): ResolvedProcessSharedMemorySettings["mode"] => {
  if (value === undefined) return "inherit";
  if (value === "inherit" || value === "named") return value;
  throw new TypeError(`Unsupported processSharedMemory mode: ${String(value)}`);
};

export const readProcessSharedMemorySettings = (
  options: WorkerSettings | undefined,
): ResolvedProcessSharedMemorySettings => {
  const input = options?.processSharedMemory;
  if (input === undefined || typeof input === "string") {
    return {
      mode: readProcessSharedMemoryMode(input),
      unlinkOnShutdown: true,
    };
  }
  if (typeof input !== "object" || input === null) {
    throw new TypeError("processSharedMemory must be a mode or options object");
  }

  const settings = input as ProcessSharedMemoryInput & {
    mode?: unknown;
    namePrefix?: unknown;
    unlinkOnShutdown?: unknown;
  };
  const mode = readProcessSharedMemoryMode(settings.mode);
  const out: ResolvedProcessSharedMemorySettings = {
    mode,
    unlinkOnShutdown: settings.unlinkOnShutdown !== false,
  };
  if (settings.namePrefix !== undefined) {
    if (
      typeof settings.namePrefix !== "string" ||
      settings.namePrefix.length === 0 ||
      settings.namePrefix.includes("\0")
    ) {
      throw new TypeError(
        "processSharedMemory.namePrefix must be a non-empty string without NUL bytes",
      );
    }
    out.namePrefix = settings.namePrefix;
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
  [RUNTIME_POOL_DEPTH_ENV]: String(RUNTIME_POOL_DEPTH + 1),
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

const processWorkerBunBinary = (
  bun?: BunRuntimeLike,
  commandPrefix?: ProcessWorkerCommandPrefix,
): string =>
  getNodeProcess()?.env?.BUN_BINARY ??
    (commandPrefix === undefined ? bun?.argv?.[0] : undefined) ??
    DEFAULT_BUN_BINARY;

const processWorkerDenoBinary = (
  deno?: DenoRuntimeLike,
  commandPrefix?: ProcessWorkerCommandPrefix,
): string =>
  getNodeProcess()?.env?.DENO_BINARY ??
    (commandPrefix === undefined ? deno?.execPath?.() : undefined) ??
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

const processWorkerNodeBinary = (
  commandPrefix?: ProcessWorkerCommandPrefix,
): string => {
  const nodeProcess = getNodeProcess();
  return nodeProcess?.env?.NODE_BINARY ??
    (commandPrefix === undefined && RUNTIME === "node"
      ? nodeProcess?.execPath
      : undefined) ??
    DEFAULT_NODE_BINARY;
};

const processWorkerNodeExecArgv = (
  permission: WorkerData["permission"] | undefined,
): string[] => {
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
  for (const flag of nodeProcessWorkerInternalExecArgv()) add(flag);
  if (permission?.enabled === true && permission.unsafe !== true) {
    for (const flag of permission.node.flags) add(flag);
    if (permission.netAll && nodeMajorVersion() >= 25) add("--allow-net");
    // Node process workers need one native transport capability regardless of
    // task permissions: addons on Node 22/24, node:ffi on supported Node 26+ LTS.
    add(nodeProcessWorkerUsesFfi() ? "--allow-ffi" : "--allow-addons");
  }
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
      processWorkerDenoBinary(deno, commandPrefix),
      "run",
      ...processWorkerDenoFlags(permission),
      workerPath,
    ];
  } else if (processRuntime === "node") {
    command = [
      processWorkerNodeBinary(commandPrefix),
      ...processWorkerNodeExecArgv(permission),
      workerPath,
    ];
  } else {
    command = [processWorkerBunBinary(bun, commandPrefix), workerPath];
  }

  return commandPrefix === undefined
    ? command
    : [...commandPrefix, ...command] as [string, ...string[]];
};

export const createProcessWorkerNativeSignalNotifier = ({
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
    on: (
      event: "error" | "exit" | "message",
      listener: (...args: unknown[]) => void,
    ) => {
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
    env: useIpcBoot ? processWorkerEnv() : processWorkerBootEnv(bootPayload),
    stdin: processWorkerNeedsInheritedFd(memory.descriptor)
      ? memory.mapping.fd
      : "ignore",
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
  const childProcess = getNodeBuiltinModule<NodeChildProcessModuleLike>(
    "node:child_process",
  );
  if (typeof childProcess?.spawn !== "function") {
    throw new Error("node:child_process.spawn is not available");
  }

  const events = createProcessWorkerEventHub();
  const useIpcBoot = (processRuntime === "bun" || processRuntime === "node") &&
    commandPrefix === undefined;
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
      env: useIpcBoot ? processWorkerEnv() : processWorkerBootEnv(bootPayload),
      stdio: useIpcBoot
        ? [
          processWorkerNeedsInheritedFd(memory.descriptor)
            ? memory.mapping.fd
            : "ignore",
          "inherit",
          "inherit",
          "ipc",
        ]
        : [
          processWorkerNeedsInheritedFd(memory.descriptor)
            ? memory.mapping.fd
            : "ignore",
          "inherit",
          "inherit",
        ],
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

  const inheritedFd = processWorkerNeedsInheritedFd(memory.descriptor)
    ? openDenoInheritedFd(memory.mapping.fd)
    : undefined;
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
    stdin: inheritedFd === undefined ? "null" : denoFileRid(inheritedFd),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const closeInheritedFd = () => {
    try {
      inheritedFd?.close?.();
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

export const spawnProcessWorker = (
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
      throw new Error(
        "process worker runtime is only available in Node, Deno, or Bun",
      );
  }
};

export const terminateWorkerQuietly = (worker: SpawnedWorker): void => {
  try {
    // Runaway worker termination can be slow or stuck on some runtimes; once the
    // pool is closing it must not keep the host process alive.
    worker.unref?.();
    void Promise.resolve(worker.terminate()).catch(() => {});
  } catch {
  }
};

export const cleanupProcessWorkerMemoryQuietly = (
  memory: ProcessWorkerMemoryLayout | undefined,
): void => {
  try {
    memory?.cleanup();
  } catch {
  } finally {
    try {
      memory?.mapping.close?.();
    } catch {
    }
  }
};
