import { getNodeBuiltinModule, getNodeProcess } from "./node-compat.ts";
import { IS_ANDROMEDA } from "./runtime.ts";

type RuntimePortMessageHandler = (message: unknown) => void;

export type RuntimeMessagePortLike = {
  postMessage: (message: unknown) => void;
  close?: () => void;
  start?: () => void;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  onmessage?: ((event: { data?: unknown }) => void) | null;
  addEventListener?: (
    type: string,
    listener: (
      event: { data?: unknown; error?: unknown; message?: unknown },
    ) => void,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: (
      event: { data?: unknown; error?: unknown; message?: unknown },
    ) => void,
  ) => void;
};

export type RuntimeWorkerLike = RuntimeMessagePortLike & {
  terminate: () => unknown;
};

export type RuntimeMessageChannelLike = {
  port1: RuntimeMessagePortLike;
  port2: RuntimeMessagePortLike;
};

type WorkerThreadsModuleLike = {
  Worker?: new (
    specifier: string | URL,
    options?: Record<string, unknown>,
  ) => RuntimeWorkerLike;
  MessageChannel?: new () => RuntimeMessageChannelLike;
  isMainThread?: boolean;
  workerData?: unknown;
  parentPort?: RuntimeMessagePortLike | null;
};

export const RUNTIME_PROCESS_WORKER_ENV = "KNITTING_PROCESS_WORKER";
export const RUNTIME_PROCESS_WORKER_BOOT_ENV = "KNITTING_PROCESS_WORKER_BOOT";
export const RUNTIME_PROCESS_WORKER_BOOT_VERSION = 1;

export const RUNTIME_POOL_DEPTH_ENV = "KNITTING_POOL_DEPTH";

type ProcessLikeWithIpc = NonNullable<ReturnType<typeof getNodeProcess>> & {
  send?: (message: unknown) => void;
};

const nodeProcess = getNodeProcess() as ProcessLikeWithIpc | undefined;

export const RUNTIME_IS_PROCESS_WORKER =
  nodeProcess?.env?.[RUNTIME_PROCESS_WORKER_ENV] === "1";

const readPoolDepth = (): number => {
  const raw = nodeProcess?.env?.[RUNTIME_POOL_DEPTH_ENV];
  if (typeof raw !== "string") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
export const RUNTIME_POOL_DEPTH = readPoolDepth();

const workerThreads = getNodeBuiltinModule<WorkerThreadsModuleLike>(
  "node:worker_threads",
);

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
  // Andromeda has no `WorkerGlobalScope`; its worker scope is distinguished by a
  // `self` global that the main thread lacks.
  if (
    IS_ANDROMEDA &&
    typeof (globalThis as { self?: unknown }).self !== "undefined"
  ) {
    return true;
  }
  return false;
};

type WorkerConstructorLike = new (
  specifier: string | URL,
  options?: Record<string, unknown>,
) => RuntimeWorkerLike;

type MessageChannelConstructorLike = new () => RuntimeMessageChannelLike;

export const RUNTIME_WORKER = workerThreads?.Worker ??
  ((globalThis as unknown as { Worker?: WorkerConstructorLike }).Worker);

export const RUNTIME_MESSAGE_CHANNEL = workerThreads?.MessageChannel ??
  ((globalThis as unknown as {
    MessageChannel?: MessageChannelConstructorLike;
  })
    .MessageChannel);

export const HAS_NODE_WORKER_THREADS = workerThreads != null;

export const RUNTIME_IS_MAIN_THREAD = RUNTIME_IS_PROCESS_WORKER
  ? false
  : workerThreads?.isMainThread ?? !isWorkerGlobalScope();

export const RUNTIME_WORKER_DATA = workerThreads?.workerData;

export const RUNTIME_PARENT_PORT = workerThreads?.parentPort ??
  (RUNTIME_IS_PROCESS_WORKER && typeof nodeProcess?.send === "function"
    ? {
      postMessage: (message: unknown) => nodeProcess.send!(message),
    }
    : undefined);

export const createRuntimeMessageChannel = (): RuntimeMessageChannelLike => {
  if (typeof RUNTIME_MESSAGE_CHANNEL !== "function") {
    throw new Error("MessageChannel is not available in this runtime");
  }
  return new RUNTIME_MESSAGE_CHANNEL();
};

export const addRuntimeDataListener = (
  target: RuntimeMessagePortLike,
  handler: RuntimePortMessageHandler,
): void => {
  if (typeof target.on === "function") {
    target.on("message", handler);
    return;
  }
  if (typeof target.addEventListener === "function") {
    target.addEventListener("message", (event) => handler(event?.data));
    return;
  }
  target.onmessage = (event) => handler(event?.data);
};
