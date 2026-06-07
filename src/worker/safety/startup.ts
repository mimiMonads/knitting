import {
  isSharedBufferSource,
  type SharedBufferSource,
} from "../../common/shared-buffer-region.ts";
import { isLockBufferTextCompat } from "../../common/shared-buffer-text.ts";
import type { LockBuffers } from "../../types.ts";

type SharedMemoryBootData = {
  sab: SharedBufferSource | undefined;
  lock: LockBuffers | undefined;
  returnLock: LockBuffers | undefined;
};

type ImportedFunctionsState = {
  list: string[];
  ids: number[];
  names?: string[];
  listOfFunctions: readonly unknown[];
};

const hasLockBuffers = (value: LockBuffers | undefined): value is LockBuffers =>
  isSharedBufferSource(value?.headers) &&
  isSharedBufferSource(value?.lockSector) &&
  isSharedBufferSource(value?.payload) &&
  isSharedBufferSource(value?.payloadSector) &&
  (
    value?.textCompat === undefined ||
    isLockBufferTextCompat(value.textCompat)
  );

export const assertWorkerSharedMemoryBootData = (
  { sab, lock, returnLock }: SharedMemoryBootData,
): void => {
  if (!isSharedBufferSource(sab)) {
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
  { list, ids, names, listOfFunctions }: ImportedFunctionsState,
): void => {
  if (
    listOfFunctions.length > 0 &&
    (names === undefined || listOfFunctions.length === names.length)
  ) return;
  console.log(list);
  console.log(ids);
  if (names !== undefined) console.log(names);
  console.log(listOfFunctions);
  throw new Error("No imports were found.");
};
