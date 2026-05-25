import { isSharedBufferSource, } from "../../common/shared-buffer-region.js";
import { isLockBufferTextCompat } from "../../common/shared-buffer-text.js";
const hasLockBuffers = (value) => isSharedBufferSource(value?.headers) &&
    isSharedBufferSource(value?.lockSector) &&
    isSharedBufferSource(value?.payload) &&
    isSharedBufferSource(value?.payloadSector) &&
    (value?.textCompat === undefined ||
        isLockBufferTextCompat(value.textCompat));
export const assertWorkerSharedMemoryBootData = ({ sab, lock, returnLock }) => {
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
export const assertWorkerImportsResolved = ({ debug, list, ids, listOfFunctions }) => {
    if (debug?.logImportedUrl === true) {
        console.log(list);
    }
    if (listOfFunctions.length > 0)
        return;
    console.log(list);
    console.log(ids);
    console.log(listOfFunctions);
    throw new Error("No imports were found.");
};
