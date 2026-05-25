import { createSharedArrayBuffer } from "../../common/runtime.js";
import { toSharedBufferRegion, } from "../../common/shared-buffer-region.js";
const page = 1024 * 4;
const CACHE_LINE_BYTES = 64;
// Keep hot signals on separate cache lines to avoid false sharing.
const SIGNAL_OFFSETS = {
    op: 0,
    rxStatus: CACHE_LINE_BYTES,
    txStatus: CACHE_LINE_BYTES * 2,
};
export const TRANSPORT_SIGNAL_BYTES = CACHE_LINE_BYTES * 3;
const a_store = Atomics.store;
export const createSharedMemoryTransport = ({ sabObject, isMain, startTime }) => {
    const toGrow = sabObject?.size ?? page;
    const roundedSize = toGrow + ((page - (toGrow % page)) % page);
    const signalRegion = toSharedBufferRegion(sabObject?.sharedSab
        ? sabObject.sharedSab
        : createSharedArrayBuffer(roundedSize, page * page));
    const sab = signalRegion.sab;
    const baseByteOffset = signalRegion.byteOffset;
    const startAt = startTime ?? performance.now();
    const opView = new Int32Array(sab, baseByteOffset + SIGNAL_OFFSETS.op, 1);
    if (isMain)
        a_store(opView, 0, 0);
    const rxStatus = new Int32Array(sab, baseByteOffset + SIGNAL_OFFSETS.rxStatus, 1);
    a_store(rxStatus, 0, 1);
    return {
        sab: signalRegion,
        op: opView,
        startAt,
        opView,
        rxStatus,
        txStatus: new Int32Array(sab, baseByteOffset + SIGNAL_OFFSETS.txStatus, 1),
    };
};
