import type { Task } from "./lock.js";
import { type SharedBufferSource } from "../common/shared-buffer-region.js";
export type RegisterMalloc = ReturnType<typeof register>;
export type RegionRegistryPublishMode = "plain" | "atomic";
export declare const register: ({ lockSector, publishMode, }: {
    lockSector?: SharedBufferSource;
    publishMode?: RegionRegistryPublishMode;
}) => {
    allocTask: (task: Task) => number;
    setSlotLength: (slotIndex: number, payloadLen: number) => boolean;
    lockSAB: import("../common/shared-buffer-region.js").SharedBuffer;
    free: (index: number) => void;
    hostBits: Int32Array<import("../common/shared-buffer-region.js").SharedBuffer>;
    workerBits: Int32Array<import("../common/shared-buffer-region.js").SharedBuffer>;
    updateTable: () => void;
    startAndIndexToArray: (length: number) => Uint32Array<ArrayBuffer>;
};
