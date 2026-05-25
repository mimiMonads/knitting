export type SignalArguments = ReturnType<typeof createSharedMemoryTransport>;
import { type SharedBufferSource } from "../../common/shared-buffer-region.js";
import { type DebugOptions } from "../../types.js";
export declare const TRANSPORT_SIGNAL_BYTES: number;
export type Sab = {
    size?: number;
    sharedSab?: SharedBufferSource;
};
type SignalForWorker = {
    sabObject?: Sab;
    isMain: boolean;
    thread: number;
    debug?: DebugOptions;
    startTime?: number;
};
export declare const createSharedMemoryTransport: ({ sabObject, isMain, startTime }: SignalForWorker) => {
    sab: import("../../types.js").SharedBufferRegion;
    op: Int32Array<import("../../common/shared-buffer-region.js").SharedBuffer>;
    startAt: number;
    opView: Int32Array<import("../../common/shared-buffer-region.js").SharedBuffer>;
    rxStatus: Int32Array<import("../../common/shared-buffer-region.js").SharedBuffer>;
    txStatus: Int32Array<import("../../common/shared-buffer-region.js").SharedBuffer>;
};
export type MainSignal = Pick<SignalArguments, "opView" | "startAt" | "rxStatus" | "txStatus">;
export {};
