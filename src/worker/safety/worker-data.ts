import type { WorkerData } from "../../types.ts";

export const scrubWorkerDataSensitiveBuffers = (value: WorkerData): void => {
  const data = value as unknown as Record<string, unknown>;
  try {
    data.sab = undefined;
    data.lock = undefined;
    data.returnLock = undefined;
    data.permission = undefined;
  } catch {
  }
  try {
    delete data.sab;
  } catch {
  }
  try {
    delete data.lock;
  } catch {
  }
  try {
    delete data.returnLock;
  } catch {
  }
  try {
    delete data.permission;
  } catch {
  }
  try {
    Object.freeze(data);
  } catch {
  }
};
