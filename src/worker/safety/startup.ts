import type { DebugOptions, LockBuffers } from "../../types.ts";

type SharedMemoryBootData = {
  sab: SharedArrayBuffer | undefined;
  lock: LockBuffers | undefined;
  returnLock: LockBuffers | undefined;
};

type ImportedFunctionsState = {
  debug: DebugOptions | undefined;
  list: string[];
  ids: number[];
  listOfFunctions: readonly unknown[];
};

const hasLockBuffers = (value: LockBuffers | undefined): value is LockBuffers =>
  !!value?.headers && !!value?.lockSector && !!value?.payload &&
  !!value?.payloadSector;

export const assertWorkerSharedMemoryBootData = (
  { sab, lock, returnLock }: SharedMemoryBootData,
): void => {
  if (!sab) {
    throw new Error("worker missing transport SAB");
  }
  if (!hasLockBuffers(lock)) {
    throw new Error("worker missing lock SABs");
  }
  if (!hasLockBuffers(returnLock)) {
    throw new Error("worker missing return lock SABs");
  }
};

export const assertWorkerImportsResolved = (
  { debug, list, ids, listOfFunctions }: ImportedFunctionsState,
): void => {
  if (debug?.logImportedUrl === true) {
    console.log(list);
  }

  if (listOfFunctions.length > 0) return;
  console.log(list);
  console.log(ids);
  console.log(listOfFunctions);
  throw new Error("No imports were found.");
};
