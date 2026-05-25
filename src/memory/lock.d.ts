import RingQueue from "../ipc/tools/ring-queue.js";
import { type SharedBufferSource } from "../common/shared-buffer-region.js";
import { type LockBufferTextCompat } from "../common/shared-buffer-text.js";
import { type PayloadBufferOptions } from "./payload-config.js";
/**
 * TODO: Compose all the instance where the array is passed as argument
 */
export declare enum PayloadSignal {
    UNREACHABLE = 0,
    BigInt = 2,
    True = 3,
    False = 4,
    Undefined = 5,
    NaN = 6,
    Float64 = 9,
    Null = 10
}
export declare enum PayloadBuffer {
    BORDER_SIGNAL_BUFFER = 11,
    String = 11,
    Json = 12,
    StaticString = 15,
    StaticJson = 16,
    Binary = 17,
    StaticBinary = 18,
    Int32Array = 19,
    Float64Array = 20,
    BigInt64Array = 21,
    BigUint64Array = 22,
    DataView = 23,
    Error = 24,
    Date = 25,
    Symbol = 26,
    StaticSymbol = 27,
    BigInt = 28,
    StaticBigInt = 29,
    StaticInt32Array = 31,
    StaticFloat64Array = 32,
    StaticBigInt64Array = 33,
    StaticBigUint64Array = 34,
    StaticDataView = 35,
    ArrayBuffer = 36,
    StaticArrayBuffer = 37,
    Buffer = 38,
    StaticBuffer = 39,
    EnvelopeStaticHeader = 40,
    EnvelopeDynamicHeader = 41,
    EnvelopeStaticHeaderString = 42,
    EnvelopeDynamicHeaderString = 43,
    ExternalPayload = 44,
    StaticExternalPayload = 45,
    ProcessSharedBuffer = 46
}
export declare enum LockBound {
    paddingLock = 0,
    padding = 0,
    slots = 32,
    header = 0
}
export declare const LOCK_CACHE_LINE_BYTES = 64;
export declare const LOCK_SECTOR_BYTES = 256;
export type Task = [
    number,
    number,
    PayloadSignal | PayloadBuffer,
    number,
    number,
    number,
    number,
    number
] & {
    value: unknown;
    resolve: (value?: unknown) => void;
    reject: (reason?: unknown) => void;
};
export declare const PromisePayloadMarker: unique symbol;
export type PromisePayloadHandler = (task: Task, isRejected: boolean, value: unknown) => void;
export declare const beginPromisePayload: (task: Task) => boolean;
export declare const finishPromisePayload: (task: Task) => void;
export declare const isPromisePayloadPending: (task: Task) => boolean;
export declare const resetTaskLocalFlags: (task: Task) => void;
export declare enum TaskIndex {
    /**
     * Worker -> host response flags word.
     */
    FlagsToHost = 0,
    /**
     * Host -> worker request function id (low 16 bits).
     * High 16 bits are reserved for caller metadata on request path.
     * NOTE: shares the same storage word as `FlagsToHost`.
     */
    FunctionID = 0,
    ID = 1,
    Type = 2,
    Start = 3,
    End = 4,
    PayloadLen = 5,
    /**
     * Low 5 bits: region slot index (0..31).
     * High 27 bits: reserved for caller metadata (e.g. enqueue timing).
     */
    slotBuffer = 6,
    Size = 8,
    /**
     * Total slot length in Uint32 words, including the task header.
     */
    TotalBuff = 144
}
export declare const TASK_SLOT_INDEX_BITS = 5;
export declare const TASK_SLOT_INDEX_MASK: number;
export declare const TASK_SLOT_META_BITS: number;
export declare const TASK_SLOT_META_VALUE_MASK: number;
export declare const TASK_FUNCTION_ID_BITS = 16;
export declare const TASK_FUNCTION_ID_MASK: number;
export declare const TASK_FUNCTION_META_BITS: number;
export declare const TASK_FUNCTION_META_VALUE_MASK: number;
export declare const getTaskFunctionID: (task: ArrayLike<number>) => number;
export declare const setTaskFunctionID: (task: Task, functionID: number) => void;
export declare const getTaskFunctionMeta: (task: ArrayLike<number>) => number;
export declare const setTaskFunctionMeta: (task: Task, value: number) => void;
export declare const getTaskSlotIndex: (task: ArrayLike<number>) => number;
export declare const setTaskSlotIndex: (task: Task, slotIndex: number) => void;
export declare const getTaskSlotMeta: (task: ArrayLike<number>) => number;
export declare const setTaskSlotMeta: (task: Task, value: number) => void;
export declare enum TaskFlag {
    Reject = 1
}
export declare const LOCK_WORD_BYTES: number;
export declare const LOCK_HOST_BITS_OFFSET_BYTES = LockBound.paddingLock;
export declare const LOCK_WORKER_BITS_OFFSET_BYTES = 64;
export declare const LOCK_SECTOR_BYTE_LENGTH = 256;
export declare const PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES: number;
export declare const PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES: number;
export declare const PAYLOAD_LOCK_SECTOR_BYTE_LENGTH = 256;
export declare const HEADER_SLOT_STRIDE_U32: number;
export declare const HEADER_SLOT_STRIDE_BYTES: number;
export declare const HEADER_TASK_LINE_U32: number;
export declare const HEADER_STATIC_PAYLOAD_U32: number;
export declare const HEADER_TASK_OFFSET_IN_SLOT_U32: number;
export declare const HEADER_U32_LENGTH: number;
export declare const HEADER_BYTE_LENGTH: number;
export declare const makeTask: () => Task;
type ResolveHostOptions = {
    queue: Task[];
    onResolved?: (task: Task) => void;
    shouldSettle?: (task: Task) => boolean;
    activeRejectPlaceholder?: Task["reject"];
};
/**
 * Complexity: 7 / 10
 *
 * SAFETY:
 *  - Single producer/consumer; do not call encode/decode concurrently.
 *  - Shared buffers must be the same between host/worker.
 *  - encode/decode are not re-entrant; payload codec uses a shared scratch buffer.
 */
export type Lock2 = ReturnType<typeof lock2>;
export declare const lock2: ({ headers, headerSlotStrideU32, LockBoundSector, payload, payloadConfig, payloadSector, textCompat, resultList, toSentList, recycleList, }: {
    headers?: SharedBufferSource;
    headerSlotStrideU32?: number;
    LockBoundSector?: SharedBufferSource;
    payload?: SharedBufferSource;
    payloadConfig?: PayloadBufferOptions;
    payloadSector?: SharedBufferSource;
    textCompat?: LockBufferTextCompat;
    toSentList?: RingQueue<Task>;
    resultList?: RingQueue<Task>;
    recycleList?: RingQueue<Task>;
}) => {
    enlist: (task: Task) => true;
    encode: (task: Task, state?: number) => boolean;
    encodeManyFrom: (list: RingQueue<Task>) => number;
    encodeAll: () => boolean;
    publish: (task: Task) => boolean;
    flushPending: () => boolean;
    decode: () => boolean;
    hasSpace: () => boolean;
    resolved: RingQueue<Task>;
    hostBits: Int32Array<import("../common/shared-buffer-region.js").SharedBuffer>;
    workerBits: Int32Array<import("../common/shared-buffer-region.js").SharedBuffer>;
    recyclecList: RingQueue<Task>;
    resolveHost: ({ queue, onResolved, shouldSettle, activeRejectPlaceholder, }: ResolveHostOptions) => () => number;
    hasPendingFrames: () => boolean;
    getPendingFrameCount: () => number;
    getPendingPromiseCount: () => number;
    resetPendingState: () => void;
    takeDeferredCount: () => number;
    setPromiseHandler: (handler?: PromisePayloadHandler) => void;
};
export {};
