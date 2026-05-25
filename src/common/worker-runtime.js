import { getNodeBuiltinModule, getNodeProcess } from "./node-compat.js";
export const RUNTIME_PROCESS_WORKER_ENV = "KNITTING_PROCESS_WORKER";
export const RUNTIME_PROCESS_WORKER_BOOT_ENV = "KNITTING_PROCESS_WORKER_BOOT";
export const RUNTIME_PROCESS_WORKER_BOOT_VERSION = 1;
const nodeProcess = getNodeProcess();
export const RUNTIME_IS_PROCESS_WORKER = nodeProcess?.env?.[RUNTIME_PROCESS_WORKER_ENV] === "1";
const workerThreads = getNodeBuiltinModule("node:worker_threads");
const isWorkerGlobalScope = () => {
    const scopeCtor = globalThis.WorkerGlobalScope;
    if (typeof scopeCtor !== "function")
        return false;
    try {
        return globalThis instanceof
            scopeCtor;
    }
    catch {
        return false;
    }
};
export const RUNTIME_WORKER = workerThreads?.Worker ??
    (globalThis.Worker);
export const RUNTIME_MESSAGE_CHANNEL = workerThreads?.MessageChannel ??
    (globalThis
        .MessageChannel);
export const HAS_NODE_WORKER_THREADS = workerThreads != null;
export const RUNTIME_IS_MAIN_THREAD = RUNTIME_IS_PROCESS_WORKER
    ? false
    : workerThreads?.isMainThread ?? !isWorkerGlobalScope();
export const RUNTIME_WORKER_DATA = workerThreads?.workerData;
export const RUNTIME_PARENT_PORT = workerThreads?.parentPort ??
    (RUNTIME_IS_PROCESS_WORKER && typeof nodeProcess?.send === "function"
        ? {
            postMessage: (message) => nodeProcess.send(message),
        }
        : undefined);
export const createRuntimeMessageChannel = () => {
    if (typeof RUNTIME_MESSAGE_CHANNEL !== "function") {
        throw new Error("MessageChannel is not available in this runtime");
    }
    return new RUNTIME_MESSAGE_CHANNEL();
};
export const addRuntimeDataListener = (target, handler) => {
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
