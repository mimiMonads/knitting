import RingQueue from "../ipc/tools/ring-queue.ts";
// payloadCodec is intentionally NOT statically imported: lock.ts and
// payloadCodec.ts form a cycle, and Andromeda's Nova engine stack-overflows on
// circular ES imports. Instead payloadCodec self registers its factories on
// load (see `registerLockPayloadCodec`); lock-building modules import it so it
// runs before `lock2()`. Node/Deno/Bun are unaffected.
type EncodePayloadFactory = typeof import("./payloadCodec.ts").encodePayload;
type DecodePayloadFactory = typeof import("./payloadCodec.ts").decodePayload;

let registeredEncodePayload: EncodePayloadFactory | undefined;
let registeredDecodePayload: DecodePayloadFactory | undefined;

export const registerLockPayloadCodec = (
  encode: EncodePayloadFactory,
  decode: DecodePayloadFactory,
): void => {
  registeredEncodePayload = encode;
  registeredDecodePayload = decode;
};
import {
  createSharedArrayBuffer,
  createWasmSharedArrayBuffer,
} from "../common/runtime.ts";
import {
  type SharedBufferSource,
  toSharedBufferRegion,
} from "../common/shared-buffer-region.ts";
import {
  type LockBufferTextCompat,
  probeLockBufferTextCompat,
} from "../common/shared-buffer-text.ts";
import {
  type PayloadBufferOptions,
  resolvePayloadBufferOptions,
} from "./payload-config.ts";

/**
 * TODO: Compose all the instance where the array is passed as argument
 */

// const objects replace `enum`s throughout this module: Andromeda's Nova engine
// panics on `enum`. Value access, duplicate-value members, and type preserved;
// identical emit on Node/Deno/Bun.
export const PayloadSignal = {
  UNREACHABLE: 0,
  BigInt: 2,
  True: 3,
  False: 4,
  Undefined: 5,
  NaN: 6,

  Float64: 9,
  Null: 10,
} as const;
export type PayloadSignal = typeof PayloadSignal[keyof typeof PayloadSignal];

export const PayloadBuffer = {
  BORDER_SIGNAL_BUFFER: 11,
  String: 11,
  Json: 12,
  StaticString: 15,
  StaticJson: 16,
  Binary: 17,
  StaticBinary: 18,
  Int32Array: 19,
  Float64Array: 20,
  BigInt64Array: 21,
  BigUint64Array: 22,
  DataView: 23,
  Error: 24,
  Date: 25,
  Symbol: 26,
  StaticSymbol: 27,
  BigInt: 28,
  StaticBigInt: 29,
  StaticInt32Array: 31,
  StaticFloat64Array: 32,
  StaticBigInt64Array: 33,
  StaticBigUint64Array: 34,
  StaticDataView: 35,
  ArrayBuffer: 36,
  StaticArrayBuffer: 37,
  Buffer: 38,
  StaticBuffer: 39,
  EnvelopeStaticHeader: 40,
  EnvelopeDynamicHeader: 41,
  EnvelopeStaticHeaderString: 42,
  EnvelopeDynamicHeaderString: 43,
  ExternalPayload: 44,
  StaticExternalPayload: 45,
  ProcessSharedBuffer: 46,
  BufferReference: 47,
  SharedArrayBuffer: 48,
  EnvelopeStaticHeaderExternal: 49,
  EnvelopeDynamicHeaderExternal: 50,
  EnvelopeStaticHeaderStringExternal: 51,
  EnvelopeDynamicHeaderStringExternal: 52,
  NumericArray: 53,
  StaticNumericArray: 54,
  /** EXPERIMENT: payload already lives in the arena; the frame is offset+len. */
  ArenaBinary: 55,
} as const;
export type PayloadBuffer = typeof PayloadBuffer[keyof typeof PayloadBuffer];

// Value -> name lookup (enum reverse-map), for payload-limit error labels.
// Later keys win on duplicate values (11 -> "String"), as TS enums do.
const PayloadBufferName: Record<number, string> = {};
for (const key of Object.keys(PayloadBuffer)) {
  PayloadBufferName[PayloadBuffer[key as keyof typeof PayloadBuffer]] = key;
}
export const payloadBufferName = (value: number): string =>
  PayloadBufferName[value] ?? String(value);

export const LockBound = {
  paddingLock: 0,
  padding: 0,
  slots: 32,
  header: 0,
} as const;
export type LockBound = typeof LockBound[keyof typeof LockBound];

export const LOCK_CACHE_LINE_BYTES = 64;
export const LOCK_SECTOR_BYTES = 256;

export type Task = [
  number,
  number,
  PayloadSignal | PayloadBuffer,
  number,
  number,
  number,
  number,
  number,
] & {
  value: unknown;
  finalize?: (() => void) | undefined;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
};

export const PayloadTransportFinalizer = Symbol.for(
  "knitting.payloadCodec.transportFinalizer",
);

type PayloadTransportFinalizable = {
  [PayloadTransportFinalizer]?: () => (() => void) | undefined;
};

export const PromisePayloadMarker = Symbol.for("knitting.promise.payload");

// Pass settlement state positionally to avoid allocating wrapper objects on the
// promise encode hot path.
export type PromisePayloadHandler = (
  task: Task,
  isRejected: boolean,
  value: unknown,
) => void;

const TASK_LOCAL_FLAGS_INDEX = 7;
const TASK_LOCAL_PROMISE_PENDING_FLAG = 1 << 0;
const TASK_LOCAL_PROMISE_TRACKED_FLAG = 1 << 1;

export const beginPromisePayload = (task: Task): boolean => {
  const flags = task[TASK_LOCAL_FLAGS_INDEX];
  if ((flags & TASK_LOCAL_PROMISE_PENDING_FLAG) !== 0) return false;
  task[TASK_LOCAL_FLAGS_INDEX] = (flags | TASK_LOCAL_PROMISE_PENDING_FLAG) >>>
    0;
  return true;
};

export const finishPromisePayload = (task: Task): void => {
  task[TASK_LOCAL_FLAGS_INDEX] =
    (task[TASK_LOCAL_FLAGS_INDEX] & ~TASK_LOCAL_PROMISE_PENDING_FLAG) >>> 0;
};

export const isPromisePayloadPending = (task: Task): boolean =>
  (task[TASK_LOCAL_FLAGS_INDEX] & TASK_LOCAL_PROMISE_PENDING_FLAG) !== 0;

export const resetTaskLocalFlags = (task: Task): void => {
  task[TASK_LOCAL_FLAGS_INDEX] = 0;
};

export const addTaskFinalizer = (
  task: Task,
  finalizer: () => void,
): void => {
  const previous = task.finalize;
  task.finalize = previous === undefined ? finalizer : () => {
    try {
      previous();
    } finally {
      finalizer();
    }
  };
};

export const attachPayloadTransportFinalizer = (
  task: Task,
  value: unknown,
): void => {
  if (
    task.finalize !== undefined || value === null || typeof value !== "object"
  ) {
    return;
  }

  const finalizer = (value as PayloadTransportFinalizable)[
    PayloadTransportFinalizer
  ]?.();
  if (typeof finalizer === "function") addTaskFinalizer(task, finalizer);
};

export const runTaskFinalizers = (task: Task): void => {
  const finalizer = task.finalize;
  task.finalize = undefined;
  if (finalizer !== undefined) {
    try {
      finalizer();
    } catch {
    }
  }
};

export const TaskIndex = {
  /**
   * Worker -> host response flags word.
   */
  FlagsToHost: 0,
  /**
   * Host -> worker request function id (low 16 bits).
   * High 16 bits are reserved for caller metadata on request path.
   * NOTE: shares the same storage word as `FlagsToHost`.
   */
  FunctionID: 0,
  ID: 1,
  Type: 2,
  Start: 3,
  /**
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │  ⚠  STOP. BIT 31 OF THIS WORD IS NOT YOURS.  ⚠                       │
   * └──────────────────────────────────────────────────────────────────────┘
   *
   * Hey — @mimiMonads here. If you are about to use `End` for something, read
   * this first. It cost us a genuinely nasty bug and I would rather you get the
   * two minutes than the three days.
   *
   * `End` wears two hats:
   *
   *   bits 0..30  a payload length (an envelope body length, mostly)
   *   bit  31     the HIGH BIT OF THE DYNAMIC REGION INDEX
   *
   * Why the second one is squatting here: dynamic payload regions have 64
   * identities (`DYNAMIC_PAYLOAD_SLOTS`), so their index needs 6 bits — but
   * `slotBuffer` below only has 5, and widening it would have meant touching
   * the whole header layout. So the 6th bit lives here, tucked into a bit no
   * length was ever going to reach. `tagTaskSlot()` puts it there,
   * `freeTaskSlot()` reads it back out.
   *
   * Two rules keep this standing up. Break either one and dynamic payloads
   * start silently swapping bytes between callers — no error, no crash, just
   * one caller quietly getting another caller's data. It only shows up once
   * more than 32 calls are in flight, so your tests will most likely pass and
   * your users will be the ones who find it. That is exactly how we shipped it
   * the first time.
   *
   *   1. READING `End` as a length?    mask it:  `task[TaskIndex.End] & 0x7FFFFFFF`
   *   2. WRITING `End` as a length?    write the length FIRST, then call
   *                                    `tagTaskSlot()`. Never the other way
   *                                    round — the write clobbers the tag.
   *
   * And if you need another spare bit somewhere: please do not take it from
   * here. Widen `slotBuffer`, or add a word. I know it is tempting. Don't. 🙏
   */
  End: 4,
  PayloadLen: 5,
  /**
   * Low 5 bits: dynamic region index, bits 0..4 (the 6th bit is in `End`; see
   * the warning above).
   * High 27 bits: reserved for caller metadata (e.g. enqueue timing).
   */
  slotBuffer: 6,
  Size: 8,
  /**
   * Total slot length in Uint32 words, including the task header.
   */
  TotalBuff: 144,
} as const;
export type TaskIndex = typeof TaskIndex[keyof typeof TaskIndex];

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

export const getTaskFunctionID = (task: ArrayLike<number>): number =>
  task[TaskIndex.FunctionID] & TASK_FUNCTION_ID_MASK;

export const setTaskFunctionID = (task: Task, functionID: number): void => {
  task[TaskIndex.FunctionID] = (
    (task[TaskIndex.FunctionID] & TASK_FUNCTION_META_PACKED_MASK) |
    (functionID & TASK_FUNCTION_ID_MASK)
  ) >>> 0;
};

export const getTaskFunctionMeta = (task: ArrayLike<number>): number =>
  (task[TaskIndex.FunctionID] >>> TASK_FUNCTION_ID_BITS) &
  TASK_FUNCTION_META_VALUE_MASK;

export const setTaskFunctionMeta = (task: Task, value: number): void => {
  const encodedMeta =
    ((value & TASK_FUNCTION_META_VALUE_MASK) << TASK_FUNCTION_ID_BITS) >>> 0;
  task[TaskIndex.FunctionID] =
    ((task[TaskIndex.FunctionID] & TASK_FUNCTION_ID_MASK) | encodedMeta) >>> 0;
};

export const getTaskSlotIndex = (task: ArrayLike<number>): number =>
  task[TaskIndex.slotBuffer] & TASK_SLOT_INDEX_MASK;

export const setTaskSlotIndex = (task: Task, slotIndex: number): void => {
  task[TaskIndex.slotBuffer] = (
    (task[TaskIndex.slotBuffer] & TASK_SLOT_META_PACKED_MASK) |
    (slotIndex & TASK_SLOT_INDEX_MASK)
  ) >>> 0;
};

export const getTaskSlotMeta = (task: ArrayLike<number>): number =>
  (task[TaskIndex.slotBuffer] >>> TASK_SLOT_INDEX_BITS) &
  TASK_SLOT_META_VALUE_MASK;

export const setTaskSlotMeta = (task: Task, value: number): void => {
  const encodedMeta =
    ((value & TASK_SLOT_META_VALUE_MASK) << TASK_SLOT_INDEX_BITS) >>> 0;
  task[TaskIndex.slotBuffer] =
    ((task[TaskIndex.slotBuffer] & TASK_SLOT_INDEX_MASK) | encodedMeta) >>> 0;
};

export const TaskFlag = {
  Reject: 1,
} as const;
export type TaskFlag = typeof TaskFlag[keyof typeof TaskFlag];

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
// Work-stealing control words live in the unused tail of each slot's header
// cache line. Task words occupy 0..7 (`TASK_LOCAL_FLAGS_INDEX = 7`) of the
// 16-word line, leaving words 8..15 free. Consumer `c` owns slot `c`'s words,
// and the slot stride keeps those words on separate cache lines.
// The ACK word was removed; retirement is folded into `workerBits`.
export const STEAL_ACK_SLOT_OFFSET_U32 = HEADER_TASK_OFFSET_IN_SLOT_U32 +
  TaskIndex.Size;
export const STEAL_WANT_SLOT_OFFSET_U32 = STEAL_ACK_SLOT_OFFSET_U32 + 1;
/**
 * The payload allocator needs its own participant-owned ACK per consumer, since
 * several workers can free payload slots from one shared allocator. No intent
 * word: freeing needs no arbitration, a consumer only frees what it drained.
 */
export const STEAL_PAYLOAD_ACK_SLOT_OFFSET_U32 = STEAL_ACK_SLOT_OFFSET_U32 + 2;
/**
 * Host-owned liveness mask for stealing consumers. A dead claimant may leave
 * its WANT word set forever; survivors ignore WANT from consumers whose bit is
 * clear here. This preserves single-writer ownership of every WANT word.
 */
export const STEAL_LIVE_SLOT_OFFSET_U32 = STEAL_PAYLOAD_ACK_SLOT_OFFSET_U32 + 1;
/** Host-owned arm word for the return-lock completion doorbell. */
export const DOORBELL_ARMED_SLOT_OFFSET_U32 = STEAL_LIVE_SLOT_OFFSET_U32 + 1;
/**
 * Per-region ownership sentinel for the `cas` claim discipline: region `r` uses
 * slot `r`'s copy of this word, so every region gets its own cache line and two
 * consumers claiming *different* regions never touch the same line. `0` is
 * free, otherwise it holds `consumerId + 1`, which makes ownership intrinsic --
 * no separate intent word, and a dead claimant's regions are found by scanning
 * for its tag.
 *
 * Unused by `dekker`, which deliberately has no shared writable word at all.
 */
export const STEAL_CLAIMED_SLOT_OFFSET_U32 = DOORBELL_ARMED_SLOT_OFFSET_U32 + 1;

// A producer claims ARMED before ringing the host. Keeping SIGNALLED until the
// host drains coalesces a burst of published frames into one native/IPC wake.
const DOORBELL_OFF = 0;
const DOORBELL_ARMED = 1;
const DOORBELL_SIGNALLED = 2;

export const HEADER_U32_LENGTH = LockBound.header +
  (HEADER_SLOT_STRIDE_U32 * LockBound.slots);
export const HEADER_BYTE_LENGTH = HEADER_U32_LENGTH *
  Uint32Array.BYTES_PER_ELEMENT;

let INDEX_ID = 0;
const INIT_VAL = PayloadSignal.UNREACHABLE;
const def = (_?: unknown) => {};

const createTaskShell = () => {
  const task = new Uint32Array(TaskIndex.Size) as Uint32Array & {
    value: unknown;
    finalize?: (() => void) | undefined;
    resolve: (value?: unknown) => void;
    reject: (reason?: unknown) => void;
  } as unknown as Task;
  task.value = null;
  task.finalize = undefined;
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

type ResolveHostOptions = {
  queue: Task[];
  onResolved?: (task: Task) => void;
  shouldSettle?: (task: Task) => boolean;
  activeRejectPlaceholder?: Task["reject"];
};

const fillTaskFrom = (task: Task, array: ArrayLike<number>, at: number) => {
  task[0] = array[at];
  task[1] = array[at + 1];
  // Raw numeric tag word; const-object payload "enums" are strict literal unions
  // (numeric `enum` accepted any number), so cast back on restore.
  task[2] = array[at + 2] as PayloadSignal | PayloadBuffer;
  task[3] = array[at + 3];
  task[4] = array[at + 4];
  task[5] = array[at + 5];
  task[6] = array[at + 6];
  // Task word 7 is local-only scratch state; never restore it from shared memory.
  task[TASK_LOCAL_FLAGS_INDEX] = 0;
};

const makeTaskFrom = (array: Uint32Array, at: number) => {
  const task = createTaskShell();
  fillTaskFrom(task, array, at);
  return task;
};

// could be inlined
const settleTask = (task: Task) => {
  if (task[TaskIndex["FlagsToHost"]] === 0) {
    task.resolve(task.value);
  } else {
    task.reject(task.value);
    // restarting the flag
    task[TaskIndex["FlagsToHost"]] = 0;
  }
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

/**
 * Region mutual-exclusion discipline for stealing consumers.
 *
 * - `dekker`: the paper protocol, per-consumer intent words, O(N) peer survey.
 * - `cas`: one test-and-test-and-set sentinel per region, each on its own
 *   cache line.
 * - `cas-mask`: one shared bitmask for every region. Kept as the measured
 *   comparison point for `cas` -- claiming any region contends for the same
 *   line, so peers aiming at unrelated regions still collide.
 */
export type StealClaimDiscipline = "dekker" | "cas" | "cas-mask";

export type WaitAsyncState = "not-equal" | "ok" | "timed-out";
export type WaitAsyncResult = {
  async: boolean;
  value: WaitAsyncState | PromiseLike<WaitAsyncState>;
};

export const lock2 = ({
  headers,
  headerSlotStrideU32,
  LockBoundSector,
  payload,
  payloadConfig,
  payloadSector,
  textCompat,
  resultList,
  toSentList,
  recycleList,
  processBoundary,
  sharedReturn,
  consumers,
  consumerId,
  regionLanes,
  stealClaim,
  notifyOnHostPublish,
  notifyHostPublish,
}: {
  headers?: SharedBufferSource;
  headerSlotStrideU32?: number;
  LockBoundSector?: SharedBufferSource;
  payload?: SharedBufferSource;
  payloadConfig?: PayloadBufferOptions;
  payloadSector?: SharedBufferSource;
  textCompat?: LockBufferTextCompat;
  /**
   * Host end of the slab release channel for this lane. Called with a slab token
   * once the host's view over it is unreachable, so the producing worker may
   * refill it. Slab tokens are per-isolate, so this is per-lane by construction.
   */
  toSentList?: RingQueue<Task>;
  resultList?: RingQueue<Task>;
  recycleList?: RingQueue<Task>;
  processBoundary?: boolean;
  /**
   * Hand large returns to the consumer as a borrowed region instead of copying
   * them out. Set only on a worker's return lane.
   */
  sharedReturn?: boolean;
  /**
   * Number of consumer endpoints sharing this lock. `1` (default) keeps the
   * classic single-consumer path. `> 1` enables region-Dekker work stealing and
   * is only valid on a host->worker submit lock, never on a return lock.
   */
  consumers?: number;
  /** This endpoint's id, `0..consumers-1`. Priority is fixed by id. */
  consumerId?: number;
  /** Lanes claimed per Dekker handshake. Paper rule: `slots / regionLanes >= consumers + 1`. */
  regionLanes?: number;
  /**
   * Mutual-exclusion discipline for region claiming.
   *
   * `dekker` (default) is the paper protocol: intent word per consumer, no
   * shared writable word, O(N) peer survey per claim. `cas` replaces the
   * survey with one shared owner mask and a compareExchange, making the claim
   * cost constant in consumer count at the price of a contended line.
   */
  stealClaim?: StealClaimDiscipline;
  /** Notify a host-side wait after this endpoint publishes a frame. */
  notifyOnHostPublish?: boolean;
  /** Runtime-native host wake used when Atomics.waitAsync cannot wake it. */
  notifyHostPublish?: () => void;
}) => {
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
  const lockSectorRegion = toSharedBufferRegion(
    LockBoundSector ??
      createWasmSharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
  );
  const LockBoundSAB = lockSectorRegion.sab;

  const hostBits = new Int32Array(
    LockBoundSAB,
    lockSectorRegion.byteOffset + LOCK_HOST_BITS_OFFSET_BYTES,
    1,
  );
  const workerBits = new Int32Array(
    LockBoundSAB,
    lockSectorRegion.byteOffset + LOCK_WORKER_BITS_OFFSET_BYTES,
    1,
  );

  const headersRegion = toSharedBufferRegion(
    headers ?? createWasmSharedArrayBuffer(HEADER_BYTE_LENGTH),
  );

  const headersBuffer = new Uint32Array(
    headersRegion.sab,
    headersRegion.byteOffset,
    headersRegion.byteLength >>> 2,
  );
  const headersSlotStride = headerSlotStrideU32 ?? HEADER_SLOT_STRIDE_U32;
  // The first task cache line has four unused control words after the task
  // header. Keep the doorbell arm bit in one of those words so the host and
  // worker lock instances can share it without allocating another SAB.
  const doorbellArmed = new Int32Array(
    headersRegion.sab,
    headersRegion.byteOffset +
      (DOORBELL_ARMED_SLOT_OFFSET_U32 * Uint32Array.BYTES_PER_ELEMENT),
    1,
  );

  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payload,
    options: payloadConfig,
  });
  const payloadSAB: SharedBufferSource = payload ??
    (
      resolvedPayloadConfig.mode === "growable"
        ? createSharedArrayBuffer(
          resolvedPayloadConfig.payloadInitialBytes,
          resolvedPayloadConfig.payloadMaxByteLength,
        )
        : createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes)
    );
  const payloadLockRegion = toSharedBufferRegion(
    payloadSector ?? lockSectorRegion,
  );
  const resolvedTextCompat = textCompat ?? probeLockBufferTextCompat({
    headers: headersRegion,
    payload: payloadSAB,
  });

  // ---- work stealing (multi-consumer) state ----
  // With N consumers the pending set is A ^ ACK[0] ^ ... ^ ACK[N-1]; every word
  // still has exactly one writer, so no shared writable word is introduced.
  const stealConsumers = Math.max(1, (consumers ?? 1) | 0);
  const stealEnabled = stealConsumers > 1;
  // A lock2 built without `consumerId` is the producer endpoint: it encodes but
  // never claims. It still frees payload slots, so it needs an acknowledgement
  // word of its own rather than sharing consumer 0's.
  const stealIsProducer = consumerId === undefined;
  const stealId = (consumerId ?? 0) | 0;
  const stealRegionLanes = (regionLanes ?? 8) | 0;
  const stealRegions = (LockBound.slots / stealRegionLanes) | 0;
  const stealClaimSentinel = stealClaim === "cas";
  const stealClaimMask = stealClaim === "cas-mask";
  const stealClaimCas = stealClaimSentinel || stealClaimMask;

  if (stealEnabled) {
    if (
      stealRegionLanes < 1 || (stealRegionLanes & (stealRegionLanes - 1)) !== 0
    ) {
      throw new RangeError("regionLanes must be a power of two");
    }
    // `R >= N` is a Dekker requirement: a junior withdraws for a senior, so a
    // claimant needs a region no live peer is aiming at. A CAS claimant that
    // finds every region owned simply bails and retries, so region width is
    // free to exceed what that rule allows -- which is the point, since a
    // region is the batch a claim retires.
    if (!stealClaimCas && stealRegions < stealConsumers) {
      throw new RangeError(
        `regionLanes=${stealRegionLanes} yields ${stealRegions} regions, ` +
          `too few for ${stealConsumers} consumers`,
      );
    }
    if (stealId < 0 || stealId >= stealConsumers) {
      throw new RangeError(`consumerId ${stealId} out of range`);
    }
  }

  // Int32 alias over the headers SAB so the control words get signed bit math
  // consistent with the rest of the protocol.
  const stealView = new Int32Array(
    headersRegion.sab,
    headersRegion.byteOffset,
    headersRegion.byteLength >>> 2,
  );
  const stealWantIndex = new Int32Array(stealConsumers);
  for (let c = 0; c < stealConsumers; c++) {
    stealWantIndex[c] = (c * headersSlotStride) + LockBound.header +
      STEAL_WANT_SLOT_OFFSET_U32;
  }
  const stealLiveIndex = LockBound.header + STEAL_LIVE_SLOT_OFFSET_U32;
  /** Single shared owner bitmask, used by `cas-mask` only. */
  const stealMaskIndex = LockBound.header + STEAL_CLAIMED_SLOT_OFFSET_U32;
  // Region r's sentinel lives on slot r's control line, one cache line apart.
  const stealClaimedIndex = new Int32Array(
    stealClaimSentinel ? stealRegions : 0,
  );
  for (let r = 0; r < stealClaimedIndex.length; r++) {
    stealClaimedIndex[r] = (r * headersSlotStride) + LockBound.header +
      STEAL_CLAIMED_SLOT_OFFSET_U32;
  }
  /** Sentinel value that marks this endpoint as a region's owner. */
  const stealOwnerTag = (stealId + 1) | 0;
  const stealAllLiveMask = stealConsumers === 32
    ? -1
    : ((1 << stealConsumers) - 1) | 0;
  if (stealEnabled && stealIsProducer) {
    Atomics.store(stealView, stealLiveIndex, stealAllLiveMask);
    // A carpet can outlive one pool on a reused buffer; never inherit owners.
    if (stealClaimMask) Atomics.store(stealView, stealMaskIndex, 0);
    if (stealClaimSentinel) {
      for (let r = 0; r < stealRegions; r++) {
        Atomics.store(
          stealView,
          (r * headersSlotStride) + LockBound.header +
            STEAL_CLAIMED_SLOT_OFFSET_U32,
          0,
        );
      }
    }
  }

  const stealIsLive = (mask: number, consumer: number): boolean =>
    (mask & (1 << consumer)) !== 0;

  let promiseHandler: PromisePayloadHandler | undefined;

  if (
    registeredEncodePayload === undefined ||
    registeredDecodePayload === undefined
  ) {
    throw new Error(
      "Payload codec not registered before lock2(). Ensure the module that " +
        'builds locks imports "./payloadCodec.ts" (it self-registers on load).',
    );
  }

  const encodeTask = registeredEncodePayload({
    payload: {
      sab: payloadSAB,
      config: resolvedPayloadConfig,
    },
    headersBuffer,
    headerSlotStrideU32: headersSlotStride,
    lockSector: payloadLockRegion,
    textCompat: resolvedTextCompat,
    processBoundary,
    sharedReturn,
    onPromise: (task, isRejected, value) => {
      if (
        (task[TASK_LOCAL_FLAGS_INDEX] & TASK_LOCAL_PROMISE_TRACKED_FLAG) !==
          0 &&
        pendingPromiseCount > 0
      ) {
        task[TASK_LOCAL_FLAGS_INDEX] =
          (task[TASK_LOCAL_FLAGS_INDEX] & ~TASK_LOCAL_PROMISE_TRACKED_FLAG) >>>
          0;
        pendingPromiseCount = (pendingPromiseCount - 1) | 0;
      }
      promiseHandler!(task, isRejected, value);
    },
  });
  const decodeTask = registeredDecodePayload({
    payload: {
      sab: payloadSAB,
      config: resolvedPayloadConfig,
    },
    headersBuffer,
    headerSlotStrideU32: headersSlotStride,
    lockSector: payloadLockRegion,
    textCompat: resolvedTextCompat,
    processBoundary,
  });

  let LastLocal = 0 | 0;
  let LastWorker = 0 | 0;
  let lastTake = 32 | 0;

  const toBeSent = toSentList ?? new RingQueue();
  const recyclecList = recycleList ?? new RingQueue();

  const resolved = resultList ?? new RingQueue<Task>();
  let deferredCount = 0 | 0;
  let pendingPromiseCount = 0 | 0;

  // Atomics aliases (hot path)
  const a_load = Atomics.load;
  const a_store = Atomics.store;
  const a_compareExchange = Atomics.compareExchange;
  const a_notify = Atomics.notify;
  const shouldNotifyHostPublish = notifyOnHostPublish === true;
  const a_waitAsync = typeof Atomics.waitAsync === "function"
    ? Atomics.waitAsync.bind(Atomics)
    : undefined;

  // Sender-side cached shadow of the receiver-owned queue word. Under the XSC
  // false-busy-only sender-side staleness property, this may hide newly freed
  // lanes but cannot make a genuinely pending lane appear free. Refresh only
  // when the cached free set is exhausted.
  let workerShadow = 0 | 0;
  // Under stealing, workerBits also records retired lanes.
  const refreshWorkerShadow = () => workerShadow = a_load(workerBits, 0) | 0;
  refreshWorkerShadow();
  const ensureSenderStateHasFree = (state: number): number =>
    (~state) !== 0 ? state : (LastLocal ^ refreshWorkerShadow()) | 0;

  // RingQueue method aliases (hot path)
  const toBeSentPush = (task: Task) => toBeSent.push(task);
  const toBeSentShift = () => toBeSent.shiftNoClear();
  const toBeSentUnshift = (task: Task) => toBeSent.unshift(task);
  const recycleShift = () => recyclecList.shiftNoClear();
  const resolvedPush = (task: Task) => resolved.push(task);

  const clz32 = Math.clz32;
  const slotBaseU32 = LockBound.header + HEADER_TASK_OFFSET_IN_SLOT_U32;
  const takeTask = ({ queue }: { queue: Task[] }) => (at: number) => {
    const off = (at * headersSlotStride) + slotBaseU32;
    const task = queue[headersBuffer[off + TaskIndex.ID]!];
    fillTaskFrom(task, headersBuffer, off);
    return task;
  };

  const enlist = (task: Task) => toBeSentPush(task);
  const trackDeferredTask = (task: Task) => {
    const flags = task[TASK_LOCAL_FLAGS_INDEX];
    if ((flags & TASK_LOCAL_PROMISE_TRACKED_FLAG) !== 0) return;
    task[TASK_LOCAL_FLAGS_INDEX] = (flags | TASK_LOCAL_PROMISE_TRACKED_FLAG) >>>
      0;
    pendingPromiseCount = (pendingPromiseCount + 1) | 0;
  };
  const encodeTaskValue = (task: Task, slotIndex: number): boolean =>
    encodeTask(task, slotIndex);
  let selectedSlotIndex = 0 | 0, selectedSlotBit = 0 >>> 0;

  const encodeWithState = (task: Task, state: number): number => {
    const free = ~state;
    if (free === 0) return 0;

    if (!encodeTaskValue(task, selectedSlotIndex = 31 - clz32(free))) return 0;
    encodeAt(
      task,
      selectedSlotIndex,
      selectedSlotBit = 1 << selectedSlotIndex,
    );
    return selectedSlotBit;
  };

  const encodeManyFrom = (
    list: RingQueue<Task>,
  ): number => {
    let state = ensureSenderStateHasFree((LastLocal ^ workerShadow) | 0);
    let encoded = 0 | 0;

    if (list === toBeSent) {
      while (true) {
        const task = toBeSentShift();
        if (!task) break;

        state = ensureSenderStateHasFree(state);
        const bit = encodeWithState(task, state) | 0;
        if (bit === 0) {
          toBeSentUnshift(task);
          break;
        }

        state = (state ^ bit) | 0;
        encoded = (encoded + 1) | 0;
      }
    } else {
      while (true) {
        const task = list.shiftNoClear();
        if (!task) break;

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

  const encodeManyTrackedFrom = (list: RingQueue<Task>): number => {
    let state = ensureSenderStateHasFree((LastLocal ^ workerShadow) | 0);
    let encoded = 0 | 0;
    deferredCount = 0 | 0;

    if (list === toBeSent) {
      while (true) {
        const task = toBeSentShift();
        if (!task) break;

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
    } else {
      while (true) {
        const task = list.shiftNoClear();
        if (!task) break;

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

  const encodeAll = (): boolean => {
    if (toBeSent.isEmpty) return true;
    encodeManyTrackedFrom(toBeSent);
    deferredCount = 0 | 0;
    return toBeSent.isEmpty;
  };

  const storeHost = (bit: number) => {
    a_store(hostBits, 0, LastLocal = (LastLocal ^ bit) | 0);
    if (
      shouldNotifyHostPublish &&
      a_compareExchange(
          doorbellArmed,
          0,
          DOORBELL_ARMED,
          DOORBELL_SIGNALLED,
        ) === DOORBELL_ARMED
    ) {
      if (notifyHostPublish !== undefined) {
        try {
          notifyHostPublish();
        } catch {
          // A callback can be unavailable after forced worker teardown. Restore
          // the arm only when it still belongs to this publication, so a later
          // result can retry without overwriting a host-side disarm/re-arm.
          a_compareExchange(
            doorbellArmed,
            0,
            DOORBELL_SIGNALLED,
            DOORBELL_ARMED,
          );
        }
      } else {
        a_notify(hostBits, 0, 1);
      }
    }
  };
  const storeWorker = (bit: number) =>
    a_store(workerBits, 0, LastWorker = (LastWorker ^ bit) | 0);
  const encode = (
    task: Task,
    state: number = (LastLocal ^ workerShadow) | 0,
  ): boolean => {
    state = ensureSenderStateHasFree(state);
    const free = ~state;
    if (free === 0) return false;

    if (!encodeTaskValue(task, selectedSlotIndex = 31 - clz32(free))) {
      return false;
    }
    return encodeAt(
      task,
      selectedSlotIndex,
      selectedSlotBit = 1 << selectedSlotIndex,
    );
  };

  const encodeTracked = (
    task: Task,
    state: number = (LastLocal ^ workerShadow) | 0,
  ): boolean => {
    deferredCount = 0 | 0;
    state = ensureSenderStateHasFree(state);
    const free = ~state;
    if (free === 0) return false;

    if (!encodeTaskValue(task, selectedSlotIndex = 31 - clz32(free))) {
      if (isPromisePayloadPending(task)) {
        deferredCount = 1;
        trackDeferredTask(task);
      }
      return false;
    }
    return encodeAt(
      task,
      selectedSlotIndex,
      selectedSlotBit = 1 << selectedSlotIndex,
    );
  };

  const encodeAt = (task: Task, at: number, bit: number): boolean => {
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
  const decode = (): boolean => {
    let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
    if (diff === 0) return false;

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
        if (pick === 0) pick = diff;

        decodeAt(selectedSlotIndex = 31 - clz32(pick));
        selectedSlotBit = 1 << (last = selectedSlotIndex);
        diff ^= selectedSlotBit;
        consumedBits = (consumedBits ^ selectedSlotBit) | 0;
      }
    } finally {
      if (consumedBits !== 0) storeWorker(consumedBits);
    }

    lastTake = last;
    return true;
  };

  /**
   * WORKER SIDE: decode, region-Dekker stealing variant.
   *
   * Claims one whole region of `stealRegionLanes` lanes per handshake, so the
   * StoreLoad barrier is amortised over the region rather than paid per task.
   * Priority is fixed by endpoint id: a junior withdraws for a senior, so at
   * most one consumer ever acknowledges a published generation.
   *
   * The C reference needs an explicit mfence between the intent store and the
   * peer loads. `Atomics.store` is sequentially consistent in JS, so that
   * barrier is implicit here and holds on x86 and ARM alike.
   */
  const stealLaneMask = (region: number): number =>
    stealRegionLanes === 32
      ? -1
      : ((((1 << stealRegionLanes) - 1) << (region * stealRegionLanes)) | 0);

  const stealJuniorWants = (intent: number): boolean => {
    const live = a_load(stealView, stealLiveIndex) | 0;
    for (let c = stealId + 1; c < stealConsumers; c++) {
      if (!stealIsLive(live, c)) continue;
      if ((a_load(stealView, stealWantIndex[c]!) & intent) !== 0) return true;
    }
    return false;
  };

  const stealHome = ((stealRegions * stealId) / stealConsumers) | 0;
  let stealCursor = stealHome;

  const decodeSteal = (): boolean => {
    // workerBits includes retired lanes under stealing.
    const pending = (a_load(hostBits, 0) ^ a_load(workerBits, 0)) | 0;
    if (pending === 0) return false;

    let pendingRegions = 0 | 0;
    if (stealRegions === 1) pendingRegions = 1;
    else {
      for (let r = 0; r < stealRegions; r++) {
        if ((pending & stealLaneMask(r)) !== 0) pendingRegions |= 1 << r;
      }
    }

    const liveBeforeClaim = a_load(stealView, stealLiveIndex) | 0;

    // Survey every live peer's intent before picking a region, so the one we
    // aim at is a region nobody else wants. This looks like pure overhead --
    // it is an O(N) fold that only chooses a target, while the Dekker
    // handshake below is what actually makes the claim safe -- but dropping it
    // is a regression: measured with `bench/steal/claim-cost.ts` under
    // saturation it costs ~11% throughput at 6 consumers (3/3 alternating
    // pairs, tasks/claim 3.87 -> 3.80) and gains only ~5% at 15. The loads it
    // saves are cheaper than the collisions it prevents, until the pool is
    // wide enough that the fold itself dominates. It is also off the idle
    // path: `decodeSteal` returns on `pending === 0` above, so an idle
    // claimant pays two loads, not N.
    let peerIntent = 0 | 0;
    let seniorIntent = 0 | 0;
    for (let c = 0; c < stealConsumers; c++) {
      if (c === stealId || !stealIsLive(liveBeforeClaim, c)) continue;
      const value = a_load(stealView, stealWantIndex[c]!) | 0;
      peerIntent |= value;
      if (c < stealId) seniorIntent |= value;
    }

    const notSenior = pendingRegions & ~seniorIntent;
    if (notSenior === 0) return false;
    const clean = pendingRegions & ~peerIntent;
    const candidates = clean !== 0 ? clean : notSenior;

    let region = -1;
    for (let step = 0; step < stealRegions; step++) {
      const candidate = (stealCursor + step) % stealRegions;
      if ((candidates & (1 << candidate)) !== 0) {
        region = candidate;
        break;
      }
    }
    if (region < 0) return false;
    const intent = (1 << region) | 0;

    a_store(stealView, stealWantIndex[stealId]!, intent);
    // Dekker StoreLoad: implicit, `Atomics.store` above is seq-cst.

    // Seniors decide whether we withdraw, so read them first and stop at the
    // first conflict: once one senior wants this region the junior half of the
    // scan cannot change the outcome.
    let seniorConflict = false;
    for (let c = 0; c < stealId; c++) {
      if (!stealIsLive(liveBeforeClaim, c)) continue;
      if ((a_load(stealView, stealWantIndex[c]!) & intent) !== 0) {
        seniorConflict = true;
        break;
      }
    }

    if (seniorConflict) {
      a_store(stealView, stealWantIndex[stealId]!, 0);
      return false;
    }

    let juniorConflict = false;
    for (let c = stealId + 1; c < stealConsumers; c++) {
      if (!stealIsLive(liveBeforeClaim, c)) continue;
      if ((a_load(stealView, stealWantIndex[c]!) & intent) !== 0) {
        juniorConflict = true;
        break;
      }
    }

    if (juniorConflict) {
      while (stealJuniorWants(intent)) { /* junior withdraws */ }
    }

    // Last control loads before ownership. After this no control word is read
    // until every slot in `take` has been decoded.
    const take = ((a_load(hostBits, 0) ^ a_load(workerBits, 0)) &
      stealLaneMask(region)) | 0;
    if (take === 0) {
      a_store(stealView, stealWantIndex[stealId]!, 0);
      return false;
    }

    // Retire decoded lanes and release the region even if decoding throws.
    let lanes = take;
    let done = 0 | 0;
    try {
      while (lanes !== 0) {
        const bit = (lanes & -lanes) | 0;
        decodeAt(31 - clz32(bit >>> 0));
        lanes = (lanes & (lanes - 1)) | 0;
        done = (done ^ bit) | 0;
      }
    } finally {
      // ACK before clearing intent.
      LastWorker = (LastWorker ^ done) | 0;
      if (done !== 0) Atomics.xor(workerBits, 0, done);
      a_store(stealView, stealWantIndex[stealId]!, 0);
      // Restart from this consumer's home region.
      stealCursor = stealHome;
    }
    return true;
  };

  /**
   * WORKER SIDE: decode, per-region test-and-test-and-set stealing variant.
   *
   * Every region owns a sentinel word on its own cache line, holding `0` or its
   * owner's `consumerId + 1`. A claim is: read the sentinel (a shared load, no
   * bus traffic while it stays free), and only then try to win it with one
   * `compareExchange`. Two consumers aiming at different regions never touch
   * the same line, so the cost of a claim is constant in consumer count and
   * does not grow with the number of *other* claimants either -- which the
   * single-word mask variant could not promise, because a CAS there collided
   * with peers claiming unrelated regions.
   *
   * The claim/ack split is unchanged: lanes are retired into `workerBits` after
   * decoding and the sentinel is released only then, so no lane is re-offered
   * before it is read. A region is held for the decode alone, not for
   * execution, so more consumers than regions is a legal configuration -- the
   * losers bail and retry rather than deadlocking, which is what lets region
   * width be chosen for batching instead of for `R >= N`.
   *
   * Ownership is intrinsic to the sentinel, so unlike `dekker` there is no
   * intent word to keep and no live-mask filter: `deactivateStealConsumer()`
   * hands a dead claimant's regions back by scanning for its tag.
   */
  const decodeStealCas = (): boolean => {
    const pending = (a_load(hostBits, 0) ^ a_load(workerBits, 0)) | 0;
    if (pending === 0) return false;

    let region = -1;
    let sentinel = 0 | 0;

    for (let step = 0; step < stealRegions; step++) {
      const candidate = stealCursor + step < stealRegions
        ? stealCursor + step
        : stealCursor + step - stealRegions;
      if ((pending & stealLaneMask(candidate)) === 0) continue;

      const index = stealClaimedIndex[candidate]!;
      // Test first: a contended region is skipped without an RMW, so a busy
      // region costs one shared load rather than an invalidation.
      if (a_load(stealView, index) !== 0) continue;
      if (a_compareExchange(stealView, index, 0, stealOwnerTag) !== 0) continue;

      region = candidate;
      sentinel = index;
      break;
    }

    if (region < 0) return false;

    const take = ((a_load(hostBits, 0) ^ a_load(workerBits, 0)) &
      stealLaneMask(region)) | 0;
    if (take === 0) {
      a_store(stealView, sentinel, 0);
      return false;
    }

    let lanes = take;
    let done = 0 | 0;
    try {
      while (lanes !== 0) {
        const bit = (lanes & -lanes) | 0;
        decodeAt(31 - clz32(bit >>> 0));
        lanes = (lanes & (lanes - 1)) | 0;
        done = (done ^ bit) | 0;
      }
    } finally {
      // ACK before releasing the region.
      LastWorker = (LastWorker ^ done) | 0;
      if (done !== 0) Atomics.xor(workerBits, 0, done);
      a_store(stealView, sentinel, 0);
      // Restart from this consumer's home region.
      stealCursor = stealHome;
    }
    return true;
  };

  /**
   * WORKER SIDE: decode, single shared owner-mask CAS variant.
   *
   * Kept as the measured comparison point for `decodeStealCas`: it removes the
   * same O(N) peer survey, but every region lives in one word, so a claimant
   * taking region 3 contends with a peer taking region 7. The WANT word is
   * demoted to an ownership record for `deactivateStealConsumer()`.
   */
  const decodeStealCasMask = (): boolean => {
    const pending = (a_load(hostBits, 0) ^ a_load(workerBits, 0)) | 0;
    if (pending === 0) return false;

    let owners = a_load(stealView, stealMaskIndex) | 0;
    let region = -1;
    let intent = 0 | 0;

    for (let step = 0; step < stealRegions && region < 0; step++) {
      const candidate = stealCursor + step < stealRegions
        ? stealCursor + step
        : stealCursor + step - stealRegions;
      if ((pending & stealLaneMask(candidate)) === 0) continue;
      const bit = (1 << candidate) | 0;

      // Two attempts, then move on: a lost race means the word moved under us,
      // and the next candidate is more useful than contending for this one.
      for (let attempt = 0; attempt < 2; attempt++) {
        if ((owners & bit) !== 0) break;
        const previous = a_compareExchange(
          stealView,
          stealMaskIndex,
          owners,
          (owners | bit) | 0,
        ) | 0;
        if (previous === owners) {
          region = candidate;
          intent = bit;
          break;
        }
        owners = previous;
      }
    }

    if (region < 0) return false;

    a_store(stealView, stealWantIndex[stealId]!, intent);

    const take = ((a_load(hostBits, 0) ^ a_load(workerBits, 0)) &
      stealLaneMask(region)) | 0;
    if (take === 0) {
      a_store(stealView, stealWantIndex[stealId]!, 0);
      Atomics.and(stealView, stealMaskIndex, ~intent);
      return false;
    }

    let lanes = take;
    let done = 0 | 0;
    try {
      while (lanes !== 0) {
        const bit = (lanes & -lanes) | 0;
        decodeAt(31 - clz32(bit >>> 0));
        lanes = (lanes & (lanes - 1)) | 0;
        done = (done ^ bit) | 0;
      }
    } finally {
      LastWorker = (LastWorker ^ done) | 0;
      if (done !== 0) Atomics.xor(workerBits, 0, done);
      a_store(stealView, stealWantIndex[stealId]!, 0);
      Atomics.and(stealView, stealMaskIndex, ~intent);
      stealCursor = stealHome;
    }
    return true;
  };

  /**
   * HOST SIDE: decode version
   */
  const resolveHost = ({
    queue,
    onResolved,
    shouldSettle,
    activeRejectPlaceholder,
  }: ResolveHostOptions) => {
    const getTask = takeTask({ queue });
    let lastResolved = 32;

    if (activeRejectPlaceholder !== undefined && onResolved) {
      const onResolvedTask = onResolved;
      const inactiveReject = activeRejectPlaceholder;
      return (): number => {
        let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
        if (diff === 0) return 0;

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
          if (pick === 0) pick = diff;
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

    const hasOnResolved = onResolved !== undefined;
    const onResolvedTask = onResolved ?? def;
    const shouldSettleTask = shouldSettle;

    return (): number => {
      let diff = (a_load(hostBits, 0) ^ LastWorker) | 0;
      if (diff === 0) return 0;

      let modified = 0;
      let consumedBits = 0 | 0;
      let last = lastResolved;

      if (last === 32) {
        const idx = 31 - clz32(diff);
        const selectedBit = 1 << idx;

        const task = getTask(idx);
        decodeTask(task, idx);

        consumedBits = (consumedBits ^ selectedBit) | 0;
        if (shouldSettleTask === undefined || shouldSettleTask(task)) {
          settleTask(task);
          if (hasOnResolved) onResolvedTask(task);
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
        if (pick === 0) pick = diff;
        const idx = 31 - clz32(pick);
        const selectedBit = 1 << idx;

        const task = getTask(idx);
        decodeTask(task, idx);

        consumedBits = (consumedBits ^ selectedBit) | 0;
        if (shouldSettleTask === undefined || shouldSettleTask(task)) {
          settleTask(task);
          if (hasOnResolved) onResolvedTask(task);
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

  /**
   * HOST SIDE: wait until the producer changes hostBits.
   *
   * LastWorker is the host's acknowledgement shadow. Passing it as the
   * expected value makes the arm race-free: a publication between the drain
   * and this call returns `not-equal` synchronously instead of being lost.
   */
  const waitForHostChange = (
    timeoutMs?: number,
  ): WaitAsyncResult | undefined => {
    if (a_waitAsync === undefined) {
      a_store(doorbellArmed, 0, DOORBELL_OFF);
      return undefined;
    }
    a_store(doorbellArmed, 0, DOORBELL_ARMED);
    try {
      const wait = a_waitAsync(
        hostBits,
        0,
        LastWorker | 0,
        timeoutMs,
      ) as WaitAsyncResult;
      if (!wait.async) a_store(doorbellArmed, 0, DOORBELL_OFF);
      return wait;
    } catch {
      a_store(doorbellArmed, 0, DOORBELL_OFF);
      // Some runtimes reject particular SharedArrayBuffer implementations
      // (for example a growable or native-backed buffer). Fall back to the
      // existing dispatcher rather than turning a capability issue into a
      // hung pool.
      return undefined;
    }
  };

  /**
   * Arm a native host notifier with the same no-lost-wakeup property as
   * waitAsync: a publication before or during the arm is observed directly,
   * while one after the observation sees the shared armed bit and rings.
   */
  const armHostNotifier = (): boolean => {
    a_store(doorbellArmed, 0, DOORBELL_ARMED);
    if (a_load(hostBits, 0) === (LastWorker | 0)) return true;
    a_store(doorbellArmed, 0, DOORBELL_OFF);
    return false;
  };

  const decodeAt = (at: number): boolean => {
    const off = (at * headersSlotStride) + slotBaseU32;
    const recycled = recycleShift() as Task | undefined;
    let task: Task;
    if (recycled) {
      fillTaskFrom(recycled, headersBuffer, off);
      recycled.value = null;
      recycled.finalize = undefined;
      recycled.resolve = def;
      recycled.reject = def;
      task = recycled;
    } else {
      task = makeTaskFrom(headersBuffer, off);
    }

    decodeTask(task, at);
    resolvedPush(task);

    return true;
  };

  const publish = (task: Task): boolean => {
    if (encodeTracked(task)) return true;
    if ((deferredCount | 0) !== 0) {
      deferredCount = 0 | 0;
      return false;
    }
    toBeSentPush(task);
    return false;
  };

  const flushPending = (): boolean => {
    if (toBeSent.isEmpty) return false;
    const encoded = encodeManyTrackedFrom(toBeSent) | 0;
    deferredCount = 0 | 0;
    return encoded !== 0;
  };

  const resetPendingState = () => {
    toBeSent.clear();
    deferredCount = 0 | 0;
    pendingPromiseCount = 0 | 0;
  };

  /**
   * HOST SIDE: remove a terminated consumer from stealing arbitration.
   *
   * Its ACK remains part of the generation XOR forever, because it records
   * lanes that consumer retired while alive. Only its stale WANT becomes
   * ineligible. The caller must invoke this only after the endpoint can no
   * longer execute; there is deliberately no matching reactivation operation.
   */
  const deactivateStealConsumer = (id: number): boolean => {
    if (!stealEnabled || !stealIsProducer) return false;
    if (!Number.isInteger(id) || id < 0 || id >= stealConsumers) {
      throw new RangeError(`consumerId ${id} out of range`);
    }
    const bit = 1 << id;
    const previous = Atomics.and(stealView, stealLiveIndex, ~bit);
    if (stealClaimSentinel) {
      // Claimants never consult the live mask, so a dead consumer's regions
      // have to be handed back explicitly. Its tag identifies them exactly.
      const tag = (id + 1) | 0;
      for (let r = 0; r < stealRegions; r++) {
        a_compareExchange(stealView, stealClaimedIndex[r]!, tag, 0);
      }
    } else if (stealClaimMask) {
      const stranded = a_load(stealView, stealWantIndex[id]!) | 0;
      if (stranded !== 0) Atomics.and(stealView, stealMaskIndex, ~stranded);
    }
    return (previous & bit) !== 0;
  };

  return {
    enlist,
    encode,
    encodeManyFrom,
    encodeAll,
    publish,
    flushPending,
    decode: stealEnabled
      ? (stealClaimSentinel
        ? decodeStealCas
        : stealClaimMask
        ? decodeStealCasMask
        : decodeSteal)
      : decode,
    hasSpace,
    resolved,
    hostBits,
    workerBits,
    recyclecList,
    resolveHost,
    waitForHostChange,
    armHostNotifier,
    setHostWaiterArmed: (armed: boolean) => {
      a_store(doorbellArmed, 0, armed ? DOORBELL_ARMED : DOORBELL_OFF);
    },
    hasPendingFrames: () => toBeSent.size !== 0,
    getPendingFrameCount: () => toBeSent.size | 0,
    getPendingPromiseCount: () => pendingPromiseCount | 0,
    resetPendingState,
    deactivateStealConsumer,
    takeDeferredCount: () => {
      const count = deferredCount | 0;
      deferredCount = 0 | 0;
      return count;
    },
    setPromiseHandler: (handler?: PromisePayloadHandler) => {
      promiseHandler = handler;
    },
    /**
     * Identity this lane's slab aliases are cached under. The host needs it to
     * revoke outstanding slab views when the worker behind this lane dies.
     */
  };
};
