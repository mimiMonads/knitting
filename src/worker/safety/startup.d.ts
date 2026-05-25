import { type SharedBufferSource } from "../../common/shared-buffer-region.js";
import type { DebugOptions, LockBuffers } from "../../types.js";
type SharedMemoryBootData = {
    sab: SharedBufferSource | undefined;
    lock: LockBuffers | undefined;
    returnLock: LockBuffers | undefined;
};
type ImportedFunctionsState = {
    debug: DebugOptions | undefined;
    list: string[];
    ids: number[];
    listOfFunctions: readonly unknown[];
};
export declare const assertWorkerSharedMemoryBootData: ({ sab, lock, returnLock }: SharedMemoryBootData) => void;
export declare const assertWorkerImportsResolved: ({ debug, list, ids, listOfFunctions }: ImportedFunctionsState) => void;
export {};
