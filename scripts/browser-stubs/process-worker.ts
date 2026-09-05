// Browser stub for `src/runtime/process-worker.ts`. A page cannot spawn a
// runtime executable, so `worker.runtime: "process"` is unreachable. The
// helpers every worker mode needs live in `src/runtime/worker-common.ts`.
//
// The three the pool calls unconditionally return what the real module returns
// off Node: nothing.
export const createProcessSharedMemoryAllocator = (): undefined => undefined;

export const createProcessWorkerNativeSignalNotifier = (): undefined =>
  undefined;

export const cleanupProcessWorkerMemoryQuietly = (): void => {};

// Browser workers have no parent-process IPC channel.
export const processWorkerUsesIpc = (): false => false;

const unavailable = (): never => {
  throw new Error("process workers are unavailable in the browser build");
};

export const createProcessWorkerMemoryLayout = unavailable;
export const createProcessStealMemoryLayout = unavailable;
export const readProcessSharedMemorySettings = unavailable;
export const readProcessWorkerCommandPrefix = unavailable;
export const readProcessWorkerNodeMajor = unavailable;
export const readProcessWorkerRuntime = unavailable;
export const spawnProcessWorker = unavailable;
export const toProcessWorkerBootPayload = unavailable;
