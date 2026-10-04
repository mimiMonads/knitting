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
  const found = new Set(
    listOfFunctions.map((entry) => (entry as { name?: unknown })?.name),
  );
  const missing = (names ?? []).filter((name) => !found.has(name));
  const tasks = missing.length > 0
    ? ` Missing task export(s): ${missing.join(", ")}.`
    : "";
  const modules = list.length > 0 ? ` Looked in: ${list.join(", ")}.` : "";
  throw new Error(
    `No imports were found.${tasks}${modules}` +
      " Workers re-import each listed module and look tasks up by export" +
      " name: a bare function must be exported from the module that calls" +
      " createPool, and a bundle that inlines task modules drops their" +
      " exports.",
  );
};
