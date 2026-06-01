import { RUNTIME } from "../common/runtime.ts";
import {
  RUNTIME_IS_PROCESS_WORKER,
  RUNTIME_PARENT_PORT,
  RUNTIME_PROCESS_WORKER_BOOT_ENV,
  RUNTIME_PROCESS_WORKER_BOOT_VERSION,
} from "../common/worker-runtime.ts";
import { getNodeProcess } from "../common/node-compat.ts";
import type { SharedBufferSource } from "../common/shared-buffer-region.ts";
import { isLockBufferTextCompat } from "../common/shared-buffer-text.ts";
import type { LockBuffers, WorkerData } from "../types.ts";
import {
  getDefaultProcessSharedBufferPrimitives,
  ProcessSharedBuffer,
  type ProcessSharedBufferMetadata,
  type ProcessSharedBufferPrimitives,
  setDefaultProcessSharedBufferPrimitives,
} from "../connections/process-shared-buffer.ts";
import { createBunConnectionPrimitives } from "../connections/bun.ts";
import { createDenoConnectionPrimitives } from "../connections/deno.ts";
import { loadNodeFutexAddon } from "../connections/node.ts";
import type { SharedMemoryMapping } from "../connections/types.ts";
import type { NativeWaitU32 } from "./timers.ts";

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

type ProcessWorkerBootPayload = {
  version: typeof RUNTIME_PROCESS_WORKER_BOOT_VERSION;
  workerData: ProcessWorkerWireData;
};

type ProcessLikeWithIpc = NonNullable<ReturnType<typeof getNodeProcess>> & {
  off?: (event: string, handler: (...args: unknown[]) => void) => unknown;
  removeListener?: (
    event: string,
    handler: (...args: unknown[]) => void,
  ) => unknown;
};

export const getProcessWorkerNativeWaitU32 = ():
  | NativeWaitU32
  | undefined => {
  if (!RUNTIME_IS_PROCESS_WORKER || RUNTIME !== "node") return undefined;

  try {
    return loadNodeFutexAddon().waitU32;
  } catch {
    return undefined;
  }
};

const isProcessSharedBufferMetadata = (
  value: unknown,
): value is ProcessSharedBufferMetadata => {
  try {
    ProcessSharedBuffer.fromMetadata(value);
    return true;
  } catch {
    return false;
  }
};

const isProcessWorkerWireLockBuffers = (
  value: unknown,
): value is ProcessWorkerWireLockBuffers => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProcessWorkerWireLockBuffers>;
  return isProcessSharedBufferMetadata(candidate.headers) &&
    isProcessSharedBufferMetadata(candidate.lockSector) &&
    isProcessSharedBufferMetadata(candidate.payload) &&
    isProcessSharedBufferMetadata(candidate.payloadSector) &&
    (
      candidate.textCompat === undefined ||
      isLockBufferTextCompat(candidate.textCompat)
    );
};

const isProcessWorkerBootPayload = (
  value: unknown,
): value is ProcessWorkerBootPayload => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProcessWorkerBootPayload>;
  const workerData = candidate.workerData as
    | Partial<ProcessWorkerWireData>
    | undefined;
  return candidate.version === RUNTIME_PROCESS_WORKER_BOOT_VERSION &&
    !!workerData &&
    isProcessSharedBufferMetadata(workerData.sab) &&
    Array.isArray(workerData.list) &&
    Array.isArray(workerData.ids) &&
    Array.isArray(workerData.names) &&
    Array.isArray(workerData.at) &&
    typeof workerData.thread === "number" &&
    typeof workerData.totalNumberOfThread === "number" &&
    typeof workerData.startAt === "number" &&
    (
      workerData.abortSignalSAB === undefined ||
      isProcessSharedBufferMetadata(workerData.abortSignalSAB)
    ) &&
    isProcessWorkerWireLockBuffers(workerData.lock) &&
    isProcessWorkerWireLockBuffers(workerData.returnLock);
};

const getProcessWorkerPrimitives = (): ProcessSharedBufferPrimitives => {
  const primitives = RUNTIME === "bun"
    ? createBunConnectionPrimitives()
    : RUNTIME === "deno"
    ? createDenoConnectionPrimitives()
    : getDefaultProcessSharedBufferPrimitives();
  setDefaultProcessSharedBufferPrimitives(primitives);
  return primitives;
};

const reviveProcessWorkerData = (
  wire: ProcessWorkerWireData,
): WorkerData => {
  const primitives = getProcessWorkerPrimitives();
  const mappings = new Map<string, SharedMemoryMapping>();
  const mappingKey = (descriptor: ProcessSharedBuffer["descriptor"]) =>
    descriptor.name === undefined
      ? `fd:${descriptor.fd}:${descriptor.size}:${descriptor.runtime ?? ""}`
      : `name:${descriptor.name}:${descriptor.size}:${
        descriptor.runtime ?? ""
      }`;
  const reviveRegion = (
    metadata: ProcessSharedBufferMetadata,
  ): SharedBufferSource => {
    const processBuffer = ProcessSharedBuffer.fromMetadata(metadata);
    const descriptor = processBuffer.descriptor;
    const key = mappingKey(descriptor);
    let mapping = mappings.get(key);
    if (mapping === undefined) {
      mapping = descriptor.map(primitives);
      mappings.set(key, mapping);
    } else {
      descriptor.attach(mapping);
    }

    return {
      sab: mapping.buffer,
      byteOffset: processBuffer.byteOffset,
      byteLength: processBuffer.byteLength,
    };
  };
  const reviveLockBuffers = (
    lock: ProcessWorkerWireLockBuffers,
  ): LockBuffers => ({
    ...lock,
    headers: reviveRegion(lock.headers),
    lockSector: reviveRegion(lock.lockSector),
    payload: reviveRegion(lock.payload),
    payloadSector: reviveRegion(lock.payloadSector),
  });

  return {
    ...wire,
    sab: reviveRegion(wire.sab),
    abortSignalSAB: wire.abortSignalSAB === undefined
      ? undefined
      : reviveRegion(wire.abortSignalSAB),
    lock: reviveLockBuffers(wire.lock),
    returnLock: reviveLockBuffers(wire.returnLock),
  };
};

export const installProcessWorkerBootstrap = ({
  isWorkerBootPayload,
  reportWorkerStartupFatal,
  startWorker,
}: {
  isWorkerBootPayload: (value: unknown) => value is WorkerData;
  reportWorkerStartupFatal: (error: unknown) => void;
  startWorker: (data: WorkerData) => void;
}): void => {
  const processLike = getNodeProcess() as ProcessLikeWithIpc | undefined;

  const start = (payload: ProcessWorkerBootPayload) => {
    const data = reviveProcessWorkerData(payload.workerData);
    if (!isWorkerBootPayload(data)) {
      throw new TypeError("invalid process worker boot payload");
    }
    startWorker(data);
  };
  const envBoot = processLike?.env?.[RUNTIME_PROCESS_WORKER_BOOT_ENV];
  if (typeof envBoot === "string" && envBoot.length > 0) {
    try {
      const payload = JSON.parse(envBoot);
      if (!isProcessWorkerBootPayload(payload)) {
        throw new TypeError("invalid process worker boot payload");
      }
      try {
        delete processLike?.env?.[RUNTIME_PROCESS_WORKER_BOOT_ENV];
      } catch {
      }
      start(payload);
    } catch (error) {
      reportWorkerStartupFatal(error);
    }
    return;
  }

  if (RUNTIME_PARENT_PORT === undefined) {
    reportWorkerStartupFatal(
      new TypeError("missing process worker boot payload"),
    );
    return;
  }

  if (typeof processLike?.on !== "function") return;

  const onMessage = (message: unknown) => {
    if (!isProcessWorkerBootPayload(message)) return;
    try {
      processLike.off?.("message", onMessage);
      processLike.removeListener?.("message", onMessage);
    } catch {
    }
    try {
      start(message);
    } catch (error) {
      reportWorkerStartupFatal(error);
    }
  };

  processLike.on("message", onMessage);
};
