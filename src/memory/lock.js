import RingQueue from "../ipc/tools/ring-queue.js";
import { decodePayload, encodePayload } from "./payloadCodec.js";
import { createSharedArrayBuffer, createWasmSharedArrayBuffer, } from "../common/runtime.js";
import { toSharedBufferRegion, } from "../common/shared-buffer-region.js";
import { probeLockBufferTextCompat, } from "../common/shared-buffer-text.js";
import { resolvePayloadBufferOptions, } from "./payload-config.js";
/**
 * TODO: Compose all the instance where the array is passed as argument
 */
export var PayloadSignal;
(function (PayloadSignal) {
    PayloadSignal[PayloadSignal["UNREACHABLE"] = 0] = "UNREACHABLE";
    PayloadSignal[PayloadSignal["BigInt"] = 2] = "BigInt";
    PayloadSignal[PayloadSignal["True"] = 3] = "True";
    PayloadSignal[PayloadSignal["False"] = 4] = "False";
    PayloadSignal[PayloadSignal["Undefined"] = 5] = "Undefined";
    PayloadSignal[PayloadSignal["NaN"] = 6] = "NaN";
    PayloadSignal[PayloadSignal["Float64"] = 9] = "Float64";
    PayloadSignal[PayloadSignal["Null"] = 10] = "Null";
})(PayloadSignal || (PayloadSignal = {}));
export var PayloadBuffer;
(function (PayloadBuffer) {
    PayloadBuffer[PayloadBuffer["BORDER_SIGNAL_BUFFER"] = 11] = "BORDER_SIGNAL_BUFFER";
    PayloadBuffer[PayloadBuffer["String"] = 11] = "String";
    PayloadBuffer[PayloadBuffer["Json"] = 12] = "Json";
    PayloadBuffer[PayloadBuffer["StaticString"] = 15] = "StaticString";
    PayloadBuffer[PayloadBuffer["StaticJson"] = 16] = "StaticJson";
    PayloadBuffer[PayloadBuffer["Binary"] = 17] = "Binary";
    PayloadBuffer[PayloadBuffer["StaticBinary"] = 18] = "StaticBinary";
    PayloadBuffer[PayloadBuffer["Int32Array"] = 19] = "Int32Array";
    PayloadBuffer[PayloadBuffer["Float64Array"] = 20] = "Float64Array";
    PayloadBuffer[PayloadBuffer["BigInt64Array"] = 21] = "BigInt64Array";
    PayloadBuffer[PayloadBuffer["BigUint64Array"] = 22] = "BigUint64Array";
    PayloadBuffer[PayloadBuffer["DataView"] = 23] = "DataView";
    PayloadBuffer[PayloadBuffer["Error"] = 24] = "Error";
    PayloadBuffer[PayloadBuffer["Date"] = 25] = "Date";
    PayloadBuffer[PayloadBuffer["Symbol"] = 26] = "Symbol";
    PayloadBuffer[PayloadBuffer["StaticSymbol"] = 27] = "StaticSymbol";
    PayloadBuffer[PayloadBuffer["BigInt"] = 28] = "BigInt";
    PayloadBuffer[PayloadBuffer["StaticBigInt"] = 29] = "StaticBigInt";
    PayloadBuffer[PayloadBuffer["StaticInt32Array"] = 31] = "StaticInt32Array";
    PayloadBuffer[PayloadBuffer["StaticFloat64Array"] = 32] = "StaticFloat64Array";
    PayloadBuffer[PayloadBuffer["StaticBigInt64Array"] = 33] = "StaticBigInt64Array";
    PayloadBuffer[PayloadBuffer["StaticBigUint64Array"] = 34] = "StaticBigUint64Array";
    PayloadBuffer[PayloadBuffer["StaticDataView"] = 35] = "StaticDataView";
    PayloadBuffer[PayloadBuffer["ArrayBuffer"] = 36] = "ArrayBuffer";
    PayloadBuffer[PayloadBuffer["StaticArrayBuffer"] = 37] = "StaticArrayBuffer";
    PayloadBuffer[PayloadBuffer["Buffer"] = 38] = "Buffer";
    PayloadBuffer[PayloadBuffer["StaticBuffer"] = 39] = "StaticBuffer";
    PayloadBuffer[PayloadBuffer["EnvelopeStaticHeader"] = 40] = "EnvelopeStaticHeader";
    PayloadBuffer[PayloadBuffer["EnvelopeDynamicHeader"] = 41] = "EnvelopeDynamicHeader";
    PayloadBuffer[PayloadBuffer["EnvelopeStaticHeaderString"] = 42] = "EnvelopeStaticHeaderString";
    PayloadBuffer[PayloadBuffer["EnvelopeDynamicHeaderString"] = 43] = "EnvelopeDynamicHeaderString";
    PayloadBuffer[PayloadBuffer["ExternalPayload"] = 44] = "ExternalPayload";
    PayloadBuffer[PayloadBuffer["StaticExternalPayload"] = 45] = "StaticExternalPayload";
    PayloadBuffer[PayloadBuffer["ProcessSharedBuffer"] = 46] = "ProcessSharedBuffer";
})(PayloadBuffer || (PayloadBuffer = {}));
export var LockBound;
(function (LockBound) {
    LockBound[LockBound["paddingLock"] = 0] = "paddingLock";
    LockBound[LockBound["padding"] = 0] = "padding";
    LockBound[LockBound["slots"] = 32] = "slots";
    LockBound[LockBound["header"] = 0] = "header";
})(LockBound || (LockBound = {}));
export const LOCK_CACHE_LINE_BYTES = 64;
export const LOCK_SECTOR_BYTES = 256;
export const PromisePayloadMarker = Symbol.for("knitting.promise.payload");
const TASK_LOCAL_FLAGS_INDEX = 7;
const TASK_LOCAL_PROMISE_PENDING_FLAG = 1 << 0;
const TASK_LOCAL_PROMISE_TRACKED_FLAG = 1 << 1;
export const beginPromisePayload = (task) => {
    const flags = task[TASK_LOCAL_FLAGS_INDEX];
    if ((flags & TASK_LOCAL_PROMISE_PENDING_FLAG) !== 0)
        return false;
    task[TASK_LOCAL_FLAGS_INDEX] = (flags | TASK_LOCAL_PROMISE_PENDING_FLAG) >>> 0;
    return true;
};
export const finishPromisePayload = (task) => {
    task[TASK_LOCAL_FLAGS_INDEX] =
        (task[TASK_LOCAL_FLAGS_INDEX] & ~TASK_LOCAL_PROMISE_PENDING_FLAG) >>> 0;
};
export const isPromisePayloadPending = (task) => (task[TASK_LOCAL_FLAGS_INDEX] & TASK_LOCAL_PROMISE_PENDING_FLAG) !== 0;
export const resetTaskLocalFlags = (task) => {
    task[TASK_LOCAL_FLAGS_INDEX] = 0;
};
export var TaskIndex;
(function (TaskIndex) {
    /**
     * Worker -> host response flags word.
     */
    TaskIndex[TaskIndex["FlagsToHost"] = 0] = "FlagsToHost";
    /**
     * Host -> worker request function id (low 16 bits).
     * High 16 bits are reserved for caller metadata on request path.
     * NOTE: shares the same storage word as `FlagsToHost`.
     */
    TaskIndex[TaskIndex["FunctionID"] = 0] = "FunctionID";
    TaskIndex[TaskIndex["ID"] = 1] = "ID";
    TaskIndex[TaskIndex["Type"] = 2] = "Type";
    TaskIndex[TaskIndex["Start"] = 3] = "Start";
    TaskIndex[TaskIndex["End"] = 4] = "End";
    TaskIndex[TaskIndex["PayloadLen"] = 5] = "PayloadLen";
    /**
     * Low 5 bits: region slot index (0..31).
     * High 27 bits: reserved for caller metadata (e.g. enqueue timing).
     */
    TaskIndex[TaskIndex["slotBuffer"] = 6] = "slotBuffer";
    TaskIndex[TaskIndex["Size"] = 8] = "Size";
    /**
     * Total slot length in Uint32 words, including the task header.
     */
    TaskIndex[TaskIndex["TotalBuff"] = 144] = "TotalBuff";
})(TaskIndex || (TaskIndex = {}));
export const TASK_SLOT_INDEX_BITS = 5;
export const TASK_SLOT_INDEX_MASK = (1 << TASK_SLOT_INDEX_BITS) - 1;
export const TASK_SLOT_META_BITS = 32 - TASK_SLOT_INDEX_BITS;
export const TASK_SLOT_META_VALUE_MASK = 0xFFFFFFFF >>> TASK_SLOT_INDEX_BITS;
const TASK_SLOT_META_PACKED_MASK = (~TASK_SLOT_INDEX_MASK) >>> 0;
export const TASK_FUNCTION_ID_BITS = 16;
export const TASK_FUNCTION_ID_MASK = (1 << TASK_FUNCTION_ID_BITS) - 1;
export const TASK_FUNCTION_META_BITS = 32 - TASK_FUNCTION_ID_BITS;
export const TASK_FUNCTION_META_VALUE_MASK = 0xFFFFFFFF >>>
    TASK_FUNCTION_ID_BITS;
const TASK_FUNCTION_META_PACKED_MASK = (~TASK_FUNCTION_ID_MASK) >>> 0;
export const getTaskFunctionID = (task) => task[TaskIndex.FunctionID] & TASK_FUNCTION_ID_MASK;
export const setTaskFunctionID = (task, functionID) => {
    task[TaskIndex.FunctionID] = ((task[TaskIndex.FunctionID] & TASK_FUNCTION_META_PACKED_MASK) |
        (functionID & TASK_FUNCTION_ID_MASK)) >>> 0;
};
export const getTaskFunctionMeta = (task) => (task[TaskIndex.FunctionID] >>> TASK_FUNCTION_ID_BITS) &
    TASK_FUNCTION_META_VALUE_MASK;
export const setTaskFunctionMeta = (task, value) => {
    const encodedMeta = ((value & TASK_FUNCTION_META_VALUE_MASK) << TASK_FUNCTION_ID_BITS) >>> 0;
    task[TaskIndex.FunctionID] =
        ((task[TaskIndex.FunctionID] & TASK_FUNCTION_ID_MASK) | encodedMeta) >>> 0;
};
export const getTaskSlotIndex = (task) => task[TaskIndex.slotBuffer] & TASK_SLOT_INDEX_MASK;
export const setTaskSlotIndex = (task, slotIndex) => {
    task[TaskIndex.slotBuffer] = ((task[TaskIndex.slotBuffer] & TASK_SLOT_META_PACKED_MASK) |
        (slotIndex & TASK_SLOT_INDEX_MASK)) >>> 0;
};
export const getTaskSlotMeta = (task) => (task[TaskIndex.slotBuffer] >>> TASK_SLOT_INDEX_BITS) &
    TASK_SLOT_META_VALUE_MASK;
export const setTaskSlotMeta = (task, value) => {
    const encodedMeta = ((value & TASK_SLOT_META_VALUE_MASK) << TASK_SLOT_INDEX_BITS) >>> 0;
    task[TaskIndex.slotBuffer] =
        ((task[TaskIndex.slotBuffer] & TASK_SLOT_INDEX_MASK) | encodedMeta) >>> 0;
};
export var TaskFlag;
(function (TaskFlag) {
    TaskFlag[TaskFlag["Reject"] = 1] = "Reject";
})(TaskFlag || (TaskFlag = {}));
// Main queue lock layout in bytes.
// The queue protocol uses two Int32 signal words, each on its own cache line:
// - hostBits at byte 0
// - workerBits at byte 64
// A slot is free when both words agree on that bit (XOR = 0), and in use when
// they differ (XOR = 1). The 32-bit mask supports up to 32 concurrent slots.
export const LOCK_WORD_BYTES = Int32Array.BYTES_PER_ELEMENT;
export const LOCK_HOST_BITS_OFFSET_BYTES = LockBound.paddingLock;
export const LOCK_WORKER_BITS_OFFSET_BYTES = LOCK_CACHE_LINE_BYTES;
export const LOCK_SECTOR_BYTE_LENGTH = LOCK_SECTOR_BYTES;
// Payload allocator lock layout in bytes.
// Share the same SAB as the main queue lock, but give each word its own line.
export const PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES = LOCK_CACHE_LINE_BYTES * 2;
export const PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES = LOCK_CACHE_LINE_BYTES * 3;
export const PAYLOAD_LOCK_SECTOR_BYTE_LENGTH = LOCK_SECTOR_BYTES;
// Header layout in Uint32 units.
// Each slot stores aligned static payload bytes first, then pads to the next
// cache line so the task header has a dedicated 64-byte line.
export const HEADER_SLOT_STRIDE_U32 = LockBound.header + TaskIndex.TotalBuff;
export const HEADER_SLOT_STRIDE_BYTES = HEADER_SLOT_STRIDE_U32 *
    Uint32Array.BYTES_PER_ELEMENT;
export const HEADER_TASK_LINE_U32 = LOCK_CACHE_LINE_BYTES /
    Uint32Array.BYTES_PER_ELEMENT;
export const HEADER_STATIC_PAYLOAD_U32 = TaskIndex.TotalBuff -
    HEADER_TASK_LINE_U32;
export const HEADER_TASK_OFFSET_IN_SLOT_U32 = HEADER_STATIC_PAYLOAD_U32;
export const HEADER_U32_LENGTH = LockBound.header +
    (HEADER_SLOT_STRIDE_U32 * LockBound.slots);
export const HEADER_BYTE_LENGTH = HEADER_U32_LENGTH *
    Uint32Array.BYTES_PER_ELEMENT;
let INDEX_ID = 0;
const INIT_VAL = PayloadSignal.UNREACHABLE;
const def = (_) => { };
const createTaskShell = () => {
    const task = new Uint32Array(TaskIndex.Size);
    task.value = null;
    task.resolve = def;
    task.reject = def;
    task[TASK_LOCAL_FLAGS_INDEX] = 0;
    return task;
};
export const makeTask = () => {
    const task = createTaskShell();
    task[TaskIndex.ID] = INDEX_ID++;
    return task;
};
const fillTaskFrom = (task, array, at) => {
    task[0] = array[at];
    task[1] = array[at + 1];
    task[2] = array[at + 2];
    task[3] = array[at + 3];
    task[4] = array[at + 4];
    task[5] = array[at + 5];
    task[6] = array[at + 6];
    // Task word 7 is local-only scratch state; never restore it from shared memory.
    task[TASK_LOCAL_FLAGS_INDEX] = 0;
};
const makeTaskFrom = (array, at) => {
    const task = createTaskShell();
    fillTaskFrom(task, array, at);
    return task;
};
// could be inlined
const settleTask = (task) => {
    if (task[TaskIndex["FlagsToHost"]] === 0) {
        task.resolve(task.value);
    }
    else {
        task.reject(task.value);
        // restarting the flag
        task[TaskIndex["FlagsToHost"]] = 0;
    }
};
export const lock2 = ({ headers, headerSlotStrideU32, LockBoundSector, payload, payloadConfig, payloadSector, textCompat, resultList, toSentList, recycleList, }) => {
    // Layout within `lockSectorRegion`:
    // - hostBits starts at byte 0
    // - workerBits starts at byte 64
    // These queue signal words are intentionally placed on separate cache lines.
    // The remaining two cache lines in the 256-byte sector are reserved for the
    // payload allocator lock (`PAYLOAD_LOCK_*` at bytes 128 and 192).
    //
    // Important: encode() always toggles `hostBits` and decode/resolveHost always
    // toggles `workerBits`, regardless of which thread calls them. This is why
    // the "return lock" (worker->host responses) still publishes into `hostBits`.
    const lockSectorRegion = toSharedBufferRegion(LockBoundSector ??
        createWasmSharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH));
    const LockBoundSAB = lockSectorRegion.sab;
    const hostBits = new Int32Array(LockBoundSAB, lockSectorRegion.byteOffset + LOCK_HOST_BITS_OFFSET_BYTES, 1);
    const workerBits = new Int32Array(LockBoundSAB, lockSectorRegion.byteOffset + LOCK_WORKER_BITS_OFFSET_BYTES, 1);
    const headersRegion = toSharedBufferRegion(headers ?? createWasmSharedArrayBuffer(HEADER_BYTE_LENGTH));
    const headersBuffer = new Uint32Array(headersRegion.sab, headersRegion.byteOffset, headersRegion.byteLength >>> 2);
    const headersSlotStride = headerSlotStrideU32 ?? HEADER_SLOT_STRIDE_U32;
    const resolvedPayloadConfig = resolvePayloadBufferOptions({
        sab: payload,
        options: payloadConfig,
    });
    const payloadSAB = payload ??
        (resolvedPayloadConfig.mode === "growable"
            ? createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes, resolvedPayloadConfig.payloadMaxByteLength)
            : createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes));
    const payloadLockRegion = toSharedBufferRegion(payloadSector ?? lockSectorRegion);
    const resolvedTextCompat = textCompat ?? probeLockBufferTextCompat({
        headers: headersRegion,
        payload: payloadSAB,
    });
    let promiseHandler;
    const encodeTask = encodePayload({
        payload: {
            sab: payloadSAB,
            config: resolvedPayloadConfig,
        },
        headersBuffer,
        headerSlotStrideU32: headersSlotStride,
        lockSector: payloadLockRegion,
        textCompat: resolvedTextCompat,
        onPromise: (task, isRejected, value) => {
            if ((task[TASK_LOCAL_FLAGS_INDEX] & TASK_LOCAL_PROMISE_TRACKED_FLAG) !== 0 &&
                pendingPromiseCount > 0) {
                task[TASK_LOCAL_FLAGS_INDEX] =
                    (task[TASK_LOCAL_FLAGS_INDEX] & ~TASK_LOCAL_PROMISE_TRACKED_FLAG) >>> 0;
                pendingPromiseCount = (pendingPromiseCount - 1) | 0;
            }
            promiseHandler(task, isRejected, value);
        },
    });
    const decodeTask = decodePayload({
        payload: {
            sab: payloadSAB,
            config: resolvedPayloadConfig,
        },
        headersBuffer,
        headerSlotStrideU32: headersSlotStride,
        lockSector: payloadLockRegion,
        textCompat: resolvedTextCompat,
    });
    let LastLocal = 0 | 0;
    let LastWorker = 0 | 0;
    let lastTake = 32 | 0;
    const toBeSent = toSentList ?? new RingQueue();
    const recyclecList = recycleList ?? new RingQueue();
    const resolved = resultList ?? new RingQueue();
    let deferredCount = 0 | 0;
    let pendingPromiseCount = 0 | 0;
    // Atomics aliases (hot path)
    const a_load = Atomics.load;
    const a_store = Atomics.store;
    // Sender-side cached shadow of the receiver-owned queue word. Under the XSC
    // false-busy-only sender-side staleness property, this may hide newly freed
    // lanes but cannot make a genuinely pending lane appear free. Refresh only
    // when the cached free set is exhausted.
    let workerShadow = a_load(workerBits, 0) | 0;
    const refreshWorkerShadow = () => workerShadow = a_load(workerBits, 0) | 0;
    const ensureSenderStateHasFree = (state) => (~state) !== 0 ? state : (LastLocal ^ refreshWorkerShadow()) | 0;
    // RingQueue method aliases (hot path)
    const toBeSentPush = (task) => toBeSent.push(task);
    const toBeSentShift = () => toBeSent.shiftNoClear();
    const toBeSentUnshift = (task) => toBeSent.unshift(task);
    const recycleShift = () => recyclecList.shiftNoClear();
    const resolvedPush = (task) => resolved.push(task);
    const clz32 = Math.clz32;
    const slotBaseU32 = LockBound.header + HEADER_TASK_OFFSET_IN_SLOT_U32;
    const takeTask = ({ queue }) => (at) => {
        const off = (at * headersSlotStride) + slotBaseU32;
        const task = queue[headersBuffer[off + TaskIndex.ID]];
        fillTaskFrom(task, headersBuffer, off);
        return task;
    };
    const enlist = (task) => toBeSentPush(task);
    const trackDeferredTask = (task) => {
        const flags = task[TASK_LOCAL_FLAGS_INDEX];
        if ((flags & TASK_LOCAL_PROMISE_TRACKED_FLAG) !== 0)
            return;
        task[TASK_LOCAL_FLAGS_INDEX] = (flags | TASK_LOCAL_PROMISE_TRACKED_FLAG) >>> 0;
        pendingPromiseCount = (pendingPromiseCount + 1) | 0;
    };
    const encodeTaskValue = (task, slotIndex) => encodeTask(task, slotIndex);
    let selectedSlotIndex = 0 | 0, selectedSlotBit = 0 >>> 0;
    const encodeWithState = (task, state) => {
        const free = ~state;
        if (free === 0)
            return 0;
        if (!encodeTaskValue(task, selectedSlotIndex = 31 - clz32(free)))
            return 0;
        encodeAt(task, selectedSlotIndex, selectedSlotBit = 1 << selectedSlotIndex);
        return selectedSlotBit;
    };
    const encodeManyFrom = (list) => {
        let state = ensureSenderStateHasFree((LastLocal ^ workerShadow) | 0);
        let encoded = 0 | 0;
        if (list === toBeSent) {
            while (true) {
                const task = toBeSentShift();
                if (!task)
                    break;
                state = ensureSenderStateHasFree(state);
                const bit = encodeWithState(task, state) | 0;
                if (bit === 0) {
                    toBeSentUnshift(task);
                    break;
                }
                state = (state ^ bit) | 0;
                encoded = (encoded + 1) | 0;
            }
        }
        else {
            while (true) {
                const task = list.shiftNoClear();
                if (!task)
                    break;
                state = ensureSenderStateHasFree(state);
                const bit = encodeWithState(task, state) | 0;
                if (bit === 0) {
                    list.unshift(task);
                    break;
                }
                state = (state ^ bit) | 0;
                encoded = (encoded + 1) | 0;
            }
        }
        return encoded;
    };
    const encodeManyTrackedFrom = (list) => {
        let state = ensureSenderStateHasFree((LastLocal ^ workerShadow) | 0);
        let encoded = 0 | 0;
        deferredCount = 0 | 0;
        if (list === toBeSent) {
            while (true) {
                const task = toBeSentShift();
                if (!task)
                    break;
                state = ensureSenderStateHasFree(state);
                const bit = encodeWithState(task, state) | 0;
                if (bit === 0) {
                    if (isPromisePayloadPending(task)) {
                        deferredCount = (deferredCount + 1) | 0;
                        trackDeferredTask(task);
                        continue;
                    }
                    toBeSentUnshift(task);
                    break;
                }
                state = (state ^ bit) | 0;
                encoded = (encoded + 1) | 0;
            }
        }
        else {
            while (true) {
                const task = list.shiftNoClear();
                if (!task)
                    break;
                state = ensureSenderStateHasFree(state);
                const bit = encodeWithState(task, state) | 0;
                if (bit === 0) {
                    if (isPromisePayloadPending(task)) {
                        deferredCount = (deferredCount + 1) | 0;
                        trackDeferredTask(task);
                        continue;
                    }
                    list.unshift(task);
                    break;
                }
                state = (state ^ bit) | 0;
                encoded = (encoded + 1) | 0;
            }
        }
        return encoded;
    };
    const encodeAll = () => {
        if (toBeSent.isEmpty)
            return true;
        encodeManyTrackedFrom(toBeSent);
        deferredCount = 0 | 0;
        return toBeSent.isEmpty;
    };
    const storeHost = (bit) => a_store(hostBits, 0, LastLocal = (LastLocal ^ bit) | 0);
    const storeWorker = (bit) => a_store(workerBits, 0, LastWorker = (LastWorker ^ bit) | 0);
    const encode = (task, state = (LastLocal ^ workerShadow) | 0) => {
        state = ensureSenderStateHasFree(state);
        const free = ~state;
        if (free === 0)
            return false;
        if (!encodeTaskValue(task, selectedSlotIndex = 31 - clz32(free))) {
            return false;
        }
        return encodeAt(task, selectedSlotIndex, selectedSlotBit = 1 << selectedSlotIndex);
    };
    const encodeTracked = (task, state = (LastLocal ^ workerShadow) | 0) => {
        deferredCount = 0 | 0;
        state = ensureSenderStateHasFree(state);
        const free = ~state;
        if (free === 0)
            return false;
        if (!encodeTaskValue(task, selectedSlotIndex = 31 - clz32(free))) {
            if (isPromisePayloadPending(task)) {
                deferredCount = 1;
                trackDeferredTask(task);
            }
            return false;
        }
        return encodeAt(task, selectedSlotIndex, selectedSlotBit = 1 << selectedSlotIndex);
    };
    const encodeAt = (task, at, bit) => {
        const off = (at * headersSlotStride) + slotBaseU32;
        headersBuffer[off] = task[0];
        headersBuffer[off + 1] = task[1];
        headersBuffer[off + 2] = task[2];
        headersBuffer[off + 3] = task[3];
        headersBuffer[off + 4] = task[4];
        headersBuffer[off + 5] = task[5];
        headersBuffer[off + 6] = task[6];
        headersBuffer[off + TASK_LOCAL_FLAGS_INDEX] = 0;
        storeHost(bit);
        return true;
    };
    const hasSpace = () => (hostBits[0] ^ LastWorker) !== 0;
    /**
     * WORKER SIDE: decode
     */
    const decode = () => {
        let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
        if (diff === 0)
            return false;
        let last = lastTake;
        let consumedBits = 0 | 0;
        try {
            if (last === 32) {
                decodeAt(selectedSlotIndex = 31 - clz32(diff));
                selectedSlotBit = 1 << (last = selectedSlotIndex);
                diff ^= selectedSlotBit;
                consumedBits = (consumedBits ^ selectedSlotBit) | 0;
            }
            while (diff !== 0) {
                let pick = diff & ((1 << last) - 1);
                if (pick === 0)
                    pick = diff;
                decodeAt(selectedSlotIndex = 31 - clz32(pick));
                selectedSlotBit = 1 << (last = selectedSlotIndex);
                diff ^= selectedSlotBit;
                consumedBits = (consumedBits ^ selectedSlotBit) | 0;
            }
        }
        finally {
            if (consumedBits !== 0)
                storeWorker(consumedBits);
        }
        lastTake = last;
        return true;
    };
    /**
     * HOST SIDE: decode version
     */
    const resolveHost = ({ queue, onResolved, shouldSettle, activeRejectPlaceholder, }) => {
        const getTask = takeTask({ queue });
        let lastResolved = 32;
        if (activeRejectPlaceholder !== undefined && onResolved) {
            const onResolvedTask = onResolved;
            const inactiveReject = activeRejectPlaceholder;
            return () => {
                let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
                if (diff === 0)
                    return 0;
                let modified = 0;
                let consumedBits = 0 | 0;
                let last = lastResolved;
                if (last === 32) {
                    const idx = 31 - clz32(diff);
                    const selectedBit = 1 << idx;
                    const task = getTask(idx);
                    decodeTask(task, idx);
                    consumedBits = (consumedBits ^ selectedBit) | 0;
                    if (task.reject !== inactiveReject) {
                        settleTask(task);
                        onResolvedTask(task);
                    }
                    diff ^= selectedBit;
                    modified++;
                    if ((modified & 7) === 0 && consumedBits !== 0) {
                        LastWorker = (LastWorker ^ consumedBits) | 0;
                        a_store(workerBits, 0, LastWorker);
                        consumedBits = 0 | 0;
                    }
                    last = idx;
                }
                while (diff !== 0) {
                    const lowerMask = last === 31 ? 0x7fffffff : ((1 << last) - 1);
                    let pick = diff & lowerMask;
                    if (pick === 0)
                        pick = diff;
                    const idx = 31 - clz32(pick);
                    const selectedBit = 1 << idx;
                    const task = getTask(idx);
                    decodeTask(task, idx);
                    consumedBits = (consumedBits ^ selectedBit) | 0;
                    if (task.reject !== inactiveReject) {
                        settleTask(task);
                        onResolvedTask(task);
                    }
                    diff ^= selectedBit;
                    modified++;
                    if ((modified & 7) === 0 && consumedBits !== 0) {
                        LastWorker = (LastWorker ^ consumedBits) | 0;
                        a_store(workerBits, 0, LastWorker);
                        consumedBits = 0 | 0;
                    }
                    last = idx;
                }
                if (consumedBits !== 0) {
                    LastWorker = (LastWorker ^ consumedBits) | 0;
                    a_store(workerBits, 0, LastWorker);
                }
                lastResolved = last;
                return modified;
            };
        }
        if (!shouldSettle) {
            if (!onResolved) {
                return () => {
                    let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
                    if (diff === 0)
                        return 0;
                    let modified = 0;
                    let consumedBits = 0 | 0;
                    let last = lastResolved;
                    if (last === 32) {
                        const idx = 31 - clz32(diff);
                        const selectedBit = 1 << idx;
                        const task = getTask(idx);
                        decodeTask(task, idx);
                        consumedBits = (consumedBits ^ selectedBit) | 0;
                        settleTask(task);
                        diff ^= selectedBit;
                        modified++;
                        if ((modified & 7) === 0 && consumedBits !== 0) {
                            LastWorker = (LastWorker ^ consumedBits) | 0;
                            a_store(workerBits, 0, LastWorker);
                            consumedBits = 0 | 0;
                        }
                        last = idx;
                    }
                    while (diff !== 0) {
                        const lowerMask = last === 31 ? 0x7fffffff : ((1 << last) - 1);
                        let pick = diff & lowerMask;
                        if (pick === 0)
                            pick = diff;
                        const idx = 31 - clz32(pick);
                        const selectedBit = 1 << idx;
                        const task = getTask(idx);
                        decodeTask(task, idx);
                        consumedBits = (consumedBits ^ selectedBit) | 0;
                        settleTask(task);
                        diff ^= selectedBit;
                        modified++;
                        if ((modified & 7) === 0 && consumedBits !== 0) {
                            LastWorker = (LastWorker ^ consumedBits) | 0;
                            a_store(workerBits, 0, LastWorker);
                            consumedBits = 0 | 0;
                        }
                        last = idx;
                    }
                    if (consumedBits !== 0) {
                        LastWorker = (LastWorker ^ consumedBits) | 0;
                        a_store(workerBits, 0, LastWorker);
                    }
                    lastResolved = last;
                    return modified;
                };
            }
            const onResolvedTask = onResolved;
            return () => {
                let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
                if (diff === 0)
                    return 0;
                let modified = 0;
                let consumedBits = 0 | 0;
                let last = lastResolved;
                if (last === 32) {
                    const idx = 31 - clz32(diff);
                    const selectedBit = 1 << idx;
                    const task = getTask(idx);
                    decodeTask(task, idx);
                    consumedBits = (consumedBits ^ selectedBit) | 0;
                    settleTask(task);
                    onResolvedTask(task);
                    diff ^= selectedBit;
                    modified++;
                    if ((modified & 7) === 0 && consumedBits !== 0) {
                        LastWorker = (LastWorker ^ consumedBits) | 0;
                        a_store(workerBits, 0, LastWorker);
                        consumedBits = 0 | 0;
                    }
                    last = idx;
                }
                while (diff !== 0) {
                    const lowerMask = last === 31 ? 0x7fffffff : ((1 << last) - 1);
                    let pick = diff & lowerMask;
                    if (pick === 0)
                        pick = diff;
                    const idx = 31 - clz32(pick);
                    const selectedBit = 1 << idx;
                    const task = getTask(idx);
                    decodeTask(task, idx);
                    consumedBits = (consumedBits ^ selectedBit) | 0;
                    settleTask(task);
                    onResolvedTask(task);
                    diff ^= selectedBit;
                    modified++;
                    if ((modified & 7) === 0 && consumedBits !== 0) {
                        LastWorker = (LastWorker ^ consumedBits) | 0;
                        a_store(workerBits, 0, LastWorker);
                        consumedBits = 0 | 0;
                    }
                    last = idx;
                }
                if (consumedBits !== 0) {
                    LastWorker = (LastWorker ^ consumedBits) | 0;
                    a_store(workerBits, 0, LastWorker);
                }
                lastResolved = last;
                return modified;
            };
        }
        const shouldSettleTask = shouldSettle;
        if (!onResolved) {
            return () => {
                let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
                if (diff === 0)
                    return 0;
                let modified = 0;
                let consumedBits = 0 | 0;
                let last = lastResolved;
                if (last === 32) {
                    const idx = 31 - clz32(diff);
                    const selectedBit = 1 << idx;
                    const task = getTask(idx);
                    decodeTask(task, idx);
                    consumedBits = (consumedBits ^ selectedBit) | 0;
                    if (shouldSettleTask(task)) {
                        settleTask(task);
                    }
                    diff ^= selectedBit;
                    modified++;
                    if ((modified & 7) === 0 && consumedBits !== 0) {
                        LastWorker = (LastWorker ^ consumedBits) | 0;
                        a_store(workerBits, 0, LastWorker);
                        consumedBits = 0 | 0;
                    }
                    last = idx;
                }
                while (diff !== 0) {
                    const lowerMask = last === 31 ? 0x7fffffff : ((1 << last) - 1);
                    let pick = diff & lowerMask;
                    if (pick === 0)
                        pick = diff;
                    const idx = 31 - clz32(pick);
                    const selectedBit = 1 << idx;
                    const task = getTask(idx);
                    decodeTask(task, idx);
                    consumedBits = (consumedBits ^ selectedBit) | 0;
                    if (shouldSettleTask(task)) {
                        settleTask(task);
                    }
                    diff ^= selectedBit;
                    modified++;
                    if ((modified & 7) === 0 && consumedBits !== 0) {
                        LastWorker = (LastWorker ^ consumedBits) | 0;
                        a_store(workerBits, 0, LastWorker);
                        consumedBits = 0 | 0;
                    }
                    last = idx;
                }
                if (consumedBits !== 0) {
                    LastWorker = (LastWorker ^ consumedBits) | 0;
                    a_store(workerBits, 0, LastWorker);
                }
                lastResolved = last;
                return modified;
            };
        }
        const onResolvedTask = onResolved;
        return () => {
            let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
            if (diff === 0)
                return 0;
            let modified = 0;
            let consumedBits = 0 | 0;
            let last = lastResolved;
            if (last === 32) {
                const idx = 31 - clz32(diff);
                const selectedBit = 1 << idx;
                const task = getTask(idx);
                decodeTask(task, idx);
                consumedBits = (consumedBits ^ selectedBit) | 0;
                if (shouldSettleTask(task)) {
                    settleTask(task);
                    onResolvedTask(task);
                }
                diff ^= selectedBit;
                modified++;
                if ((modified & 7) === 0 && consumedBits !== 0) {
                    LastWorker = (LastWorker ^ consumedBits) | 0;
                    a_store(workerBits, 0, LastWorker);
                    consumedBits = 0 | 0;
                }
                last = idx;
            }
            while (diff !== 0) {
                const lowerMask = last === 31 ? 0x7fffffff : ((1 << last) - 1);
                let pick = diff & lowerMask;
                if (pick === 0)
                    pick = diff;
                const idx = 31 - clz32(pick);
                const selectedBit = 1 << idx;
                const task = getTask(idx);
                decodeTask(task, idx);
                consumedBits = (consumedBits ^ selectedBit) | 0;
                if (shouldSettleTask(task)) {
                    settleTask(task);
                    onResolvedTask(task);
                }
                diff ^= selectedBit;
                modified++;
                if ((modified & 7) === 0 && consumedBits !== 0) {
                    LastWorker = (LastWorker ^ consumedBits) | 0;
                    a_store(workerBits, 0, LastWorker);
                    consumedBits = 0 | 0;
                }
                last = idx;
            }
            if (consumedBits !== 0) {
                LastWorker = (LastWorker ^ consumedBits) | 0;
                a_store(workerBits, 0, LastWorker);
            }
            lastResolved = last;
            return modified;
        };
    };
    const decodeAt = (at) => {
        const off = (at * headersSlotStride) + slotBaseU32;
        const recycled = recycleShift();
        let task;
        if (recycled) {
            fillTaskFrom(recycled, headersBuffer, off);
            recycled.value = null;
            recycled.resolve = def;
            recycled.reject = def;
            task = recycled;
        }
        else {
            task = makeTaskFrom(headersBuffer, off);
        }
        decodeTask(task, at);
        resolvedPush(task);
        return true;
    };
    const publish = (task) => {
        if (encodeTracked(task))
            return true;
        if ((deferredCount | 0) !== 0) {
            deferredCount = 0 | 0;
            return false;
        }
        toBeSentPush(task);
        return false;
    };
    const flushPending = () => {
        if (toBeSent.isEmpty)
            return false;
        const encoded = encodeManyTrackedFrom(toBeSent) | 0;
        deferredCount = 0 | 0;
        return encoded !== 0;
    };
    const resetPendingState = () => {
        toBeSent.clear();
        deferredCount = 0 | 0;
        pendingPromiseCount = 0 | 0;
    };
    return {
        enlist,
        encode,
        encodeManyFrom,
        encodeAll,
        publish,
        flushPending,
        decode,
        hasSpace,
        resolved,
        hostBits,
        workerBits,
        recyclecList,
        resolveHost,
        hasPendingFrames: () => toBeSent.size !== 0,
        getPendingFrameCount: () => toBeSent.size | 0,
        getPendingPromiseCount: () => pendingPromiseCount | 0,
        resetPendingState,
        takeDeferredCount: () => {
            const count = deferredCount | 0;
            deferredCount = 0 | 0;
            return count;
        },
        setPromiseHandler: (handler) => {
            promiseHandler = handler;
        },
    };
};
