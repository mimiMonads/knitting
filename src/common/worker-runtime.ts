import { getNodeBuiltinModule } from "./node-compat.ts";

type RuntimePortMessageHandler = (message: unknown) => void;

const browserBuildFlag = () =>
  (globalThis as typeof globalThis & {
    __KNITTING_BROWSER_BUILD__?: boolean;
  }).__KNITTING_BROWSER_BUILD__ === true;

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

const workerThreads =
  (globalThis as typeof globalThis & { __KNITTING_BROWSER_BUILD__?: boolean })
      .__KNITTING_BROWSER_BUILD__ === true
    ? undefined
    : getNodeBuiltinModule<WorkerThreadsModuleLike>("node:worker_threads");

const isWebWorkerScope = (): boolean => {
  const scopeCtor =
    (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope;
  if (typeof scopeCtor !== "function") return false;
  try {
    return globalThis instanceof
      (scopeCtor as new (...args: unknown[]) => object);
  } catch {
    return false;
  }
};

type WorkerConstructorLike = new (
  specifier: string | URL,
  options?: Record<string, unknown>,
) => RuntimeWorkerLike;

type MessageChannelConstructorLike = new () => RuntimeMessageChannelLike;

export const RUNTIME_WORKER = browserBuildFlag()
  ? ((globalThis as unknown as { Worker?: WorkerConstructorLike }).Worker)
  : workerThreads?.Worker ??
    ((globalThis as unknown as { Worker?: WorkerConstructorLike }).Worker);

export const RUNTIME_MESSAGE_CHANNEL = browserBuildFlag()
  ? ((globalThis as unknown as {
    MessageChannel?: MessageChannelConstructorLike;
  })
    .MessageChannel)
  : workerThreads?.MessageChannel ??
    ((globalThis as unknown as {
      MessageChannel?: MessageChannelConstructorLike;
    })
      .MessageChannel);

export const HAS_NODE_WORKER_THREADS = browserBuildFlag()
  ? false
  : workerThreads != null;

export const RUNTIME_IS_MAIN_THREAD = browserBuildFlag()
  ? !isWebWorkerScope()
  : workerThreads?.isMainThread ?? !isWebWorkerScope();

export const RUNTIME_WORKER_DATA = browserBuildFlag()
  ? undefined
  : workerThreads?.workerData;

export const RUNTIME_PARENT_PORT = browserBuildFlag()
  ? undefined
  : workerThreads?.parentPort ?? undefined;

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
