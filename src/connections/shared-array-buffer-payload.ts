import { RUNTIME } from "../common/runtime.ts";
import { getNodeProcess } from "../common/node-compat.ts";
import { getBufferReferenceCapabilities } from "./buffer-reference-native.ts";
import {
  type BufferReferenceRuntime,
  detachArrayBufferBestEffort,
} from "./buffer-reference.ts";

// Thread-worker SharedArrayBuffer transport by process-local pointer.
// SABs are shared, not moved or detached; process workers reject them.

export const SHARED_ARRAY_BUFFER_CODEC_ID =
  "knitting.sharedArrayBuffer" as const;
export const SHARED_ARRAY_BUFFER_NUMERIC_TRANSFER = Symbol.for(
  "knitting.sharedArrayBuffer.numericTransfer",
);
export const SHARED_ARRAY_BUFFER_NUMERIC_WORDS = 8;
const SHARED_ARRAY_BUFFER_TOKEN_NUMERIC_WORDS = 2;

// A slice frame names a region *inside* a pinned slab, so the payload length is
// carried explicitly instead of being the whole buffer's byteLength. Warm frames
// drop the pointer words the lane has already adopted.
export const SHARED_ARRAY_BUFFER_SLICE_WORDS = 10;
export const SHARED_ARRAY_BUFFER_SLICE_TOKEN_WORDS = 4;

const EXTERNAL_PAYLOAD_BRAND = Symbol.for("knitting.payloadCodec");

type SharedArrayBufferMetadata = {
  readonly kind: typeof SHARED_ARRAY_BUFFER_CODEC_ID;
  readonly origin: string;
  readonly runtime: string;
  readonly pointer: string;
  readonly token: string;
  readonly byteLength: number;
};

type SharedArrayBufferNumericMetadata = readonly [
  tokenLow: number,
  tokenHigh: number,
  pointerLow: number,
  pointerHigh: number,
  byteLength: number,
  runtime: number,
  originPid: number,
  mode: number,
];

type SharedArrayBufferTokenNumericMetadata = readonly [
  tokenLow: number,
  tokenHigh: number,
];

type SharedArrayBufferPayload = {
  readonly [EXTERNAL_PAYLOAD_BRAND]: typeof SHARED_ARRAY_BUFFER_CODEC_ID;
  readonly toMetadata: () => SharedArrayBufferMetadata;
  readonly [SHARED_ARRAY_BUFFER_NUMERIC_TRANSFER]: (
    transportKey?: object,
  ) =>
    | SharedArrayBufferNumericMetadata
    | SharedArrayBufferTokenNumericMetadata
    | undefined;
};

const getProcessId = (): number => {
  const proc = getNodeProcess() as { pid?: number } | undefined;
  if (proc !== undefined && typeof proc.pid === "number") return proc.pid;
  const deno =
    (globalThis as typeof globalThis & { Deno?: { pid?: number } }).Deno;
  if (typeof deno?.pid === "number") return deno.pid;
  return 0;
};

const PROCESS_ORIGIN = `${RUNTIME}:${getProcessId()}`;

const hasSharedArrayBuffer = typeof SharedArrayBuffer === "function";

export const isSharedArrayBufferValue = (
  value: unknown,
): value is SharedArrayBuffer =>
  hasSharedArrayBuffer && value instanceof SharedArrayBuffer;

// Pin each SAB once; the finalizer releases the pin when the producer SAB dies.
type SharedPin = { token: bigint; pointer: bigint; byteLength: number };

const pinnedBySab = new WeakMap<SharedArrayBuffer, SharedPin>();
const payloadBySharedBuffer = new WeakMap<object, SharedArrayBufferPayload>();
const warmedTokensByTransport = new WeakMap<object, Set<bigint>>();

// Adopted aliases are cached per transport lane, never globally. Producer tokens
// come from a per-isolate counter that restarts at 1 in every worker, so two
// workers mint the same token for different buffers; a single process-wide cache
// hands the first worker's bytes to every later worker's payload.
const adoptedByTransport = new WeakMap<
  object,
  Map<bigint, ArrayBuffer | SharedArrayBuffer>
>();
const adoptedWithoutTransport = new Map<
  bigint,
  ArrayBuffer | SharedArrayBuffer
>();

const adoptedCacheFor = (
  transportKey?: object,
): Map<bigint, ArrayBuffer | SharedArrayBuffer> => {
  if (transportKey === undefined) return adoptedWithoutTransport;
  let cache = adoptedByTransport.get(transportKey);
  if (cache === undefined) {
    cache = new Map<bigint, ArrayBuffer | SharedArrayBuffer>();
    adoptedByTransport.set(transportKey, cache);
  }
  return cache;
};

const pinFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry<bigint>((token) => {
    try {
      getBufferReferenceCapabilities().releaseShared(token);
    } catch {
      // best effort
    }
  })
  : undefined;

const splitU64 = (value: bigint): readonly [number, number] => [
  Number(value & 0xffffffffn) >>> 0,
  Number((value >> 32n) & 0xffffffffn) >>> 0,
];

const joinU64 = (low: number, high: number): bigint =>
  (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);

const encodeRuntime = (runtime: string): number => {
  switch (runtime) {
    case "node":
      return 1;
    case "deno":
      return 2;
    case "bun":
      return 3;
    default:
      return 0;
  }
};

const decodeRuntime = (value: number): string | undefined => {
  switch (value) {
    case 1:
      return "node";
    case 2:
      return "deno";
    case 3:
      return "bun";
    default:
      return undefined;
  }
};

const getWarmTokens = (transportKey?: object): Set<bigint> | undefined => {
  if (transportKey === undefined) return undefined;
  let warmTokens = warmedTokensByTransport.get(transportKey);
  if (warmTokens === undefined) {
    warmTokens = new Set<bigint>();
    warmedTokensByTransport.set(transportKey, warmTokens);
  }
  return warmTokens;
};

const pinSab = (sab: SharedArrayBuffer): SharedPin => {
  let pin = pinnedBySab.get(sab);
  if (pin === undefined) {
    const produced = getBufferReferenceCapabilities().produceShared(sab);
    pin = {
      token: produced.token,
      pointer: produced.pointer,
      byteLength: produced.byteLength,
    };
    pinnedBySab.set(sab, pin);
    pinFinalizer?.register(sab, pin.token);
  }
  return pin;
};

/** Pin a SAB for slice transport, reusing the share-once pin if it has one. */
export const pinSharedSlab = (sab: SharedArrayBuffer): SharedPin => pinSab(sab);

/** The pin backing `buffer`, when it has been shared at least once. */
export const getSharedPin = (buffer: object): SharedPin | undefined =>
  pinnedBySab.get(buffer as SharedArrayBuffer);

const makeMetadata = (pin: SharedPin): SharedArrayBufferMetadata => ({
  kind: SHARED_ARRAY_BUFFER_CODEC_ID,
  origin: PROCESS_ORIGIN,
  runtime: RUNTIME,
  pointer: pin.pointer.toString(),
  token: pin.token.toString(),
  byteLength: pin.byteLength,
});

const makeFullNumericMetadata = (
  pin: SharedPin,
): SharedArrayBufferNumericMetadata | undefined => {
  if (pin.byteLength > 0xffffffff) return undefined;
  const [tokenLow, tokenHigh] = splitU64(pin.token);
  const [pointerLow, pointerHigh] = splitU64(pin.pointer);
  return [
    tokenLow,
    tokenHigh,
    pointerLow,
    pointerHigh,
    pin.byteLength >>> 0,
    encodeRuntime(RUNTIME),
    getProcessId() >>> 0,
    0,
  ];
};

const makeTokenNumericMetadata = (
  pin: SharedPin,
): SharedArrayBufferTokenNumericMetadata => {
  const [tokenLow, tokenHigh] = splitU64(pin.token);
  return [tokenLow, tokenHigh];
};

/** Wrap a SAB as external payload; GC-managed pins mean no settle finalizer. */
export const wrapSharedArrayBufferPayload = (
  sab: SharedArrayBuffer,
): SharedArrayBufferPayload => {
  let payload = payloadBySharedBuffer.get(sab);
  if (payload !== undefined) return payload;

  const pin = pinSab(sab);
  payload = createSharedArrayBufferPayload(sab, pin, makeMetadata(pin));
  return payload;
};

const createSharedArrayBufferPayload = (
  buffer: object,
  pin: SharedPin,
  metadata: SharedArrayBufferMetadata,
): SharedArrayBufferPayload => {
  let payload = payloadBySharedBuffer.get(buffer);
  if (payload !== undefined) return payload;

  const fullNumeric = makeFullNumericMetadata(pin);
  const tokenOnlyNumeric = makeTokenNumericMetadata(pin);

  payload = {
    [EXTERNAL_PAYLOAD_BRAND]: SHARED_ARRAY_BUFFER_CODEC_ID,
    toMetadata: (): SharedArrayBufferMetadata => metadata,
    [SHARED_ARRAY_BUFFER_NUMERIC_TRANSFER]: (
      transportKey?: object,
    ): SharedArrayBufferNumericMetadata | SharedArrayBufferTokenNumericMetadata |
      undefined => {
      if (fullNumeric === undefined) {
        return undefined;
      }
      const warmTokens = getWarmTokens(transportKey);
      if (warmTokens === undefined) return fullNumeric;
      if (warmTokens.has(pin.token)) return tokenOnlyNumeric;
      warmTokens.add(pin.token);
      return fullNumeric;
    },
  };
  payloadBySharedBuffer.set(buffer, payload);
  return payload;
};

export const getSharedArrayBufferPayload = (
  value: object,
): SharedArrayBufferPayload | undefined => {
  if (isSharedArrayBufferValue(value)) return wrapSharedArrayBufferPayload(value);
  return payloadBySharedBuffer.get(value);
};

const isSharedArrayBufferMetadata = (
  value: unknown,
): value is SharedArrayBufferMetadata => {
  if (value === null || typeof value !== "object") return false;
  const meta = value as Partial<SharedArrayBufferMetadata>;
  return (
    meta.kind === SHARED_ARRAY_BUFFER_CODEC_ID &&
    typeof meta.origin === "string" &&
    typeof meta.runtime === "string" &&
    typeof meta.pointer === "string" &&
    typeof meta.token === "string" &&
    typeof meta.byteLength === "number" &&
    Number.isInteger(meta.byteLength) &&
    meta.byteLength >= 0
  );
};

const materializeSharedBuffer = (
  metadata: SharedArrayBufferMetadata,
  warmOnly: boolean,
  transportKey?: object,
): ArrayBuffer | SharedArrayBuffer => {
  if (metadata.origin !== PROCESS_ORIGIN) {
    throw new Error(
      `SharedArrayBuffer cannot cross a process boundary (origin ${metadata.origin} ` +
        `!= ${PROCESS_ORIGIN}); it is shared by reference to thread workers only.`,
    );
  }

  const token = BigInt(metadata.token);
  const cache = adoptedCacheFor(transportKey);
  const cached = cache.get(token);
  if (cached !== undefined) return cached;

  if (warmOnly) {
    throw new TypeError("SharedArrayBuffer cache miss for warm token payload");
  }

  const region = getBufferReferenceCapabilities().adoptShared({
    token,
    pointer: BigInt(metadata.pointer),
    byteOffset: 0,
    byteLength: metadata.byteLength,
  });
  cache.set(token, region.buffer);
  createSharedArrayBufferPayload(region.buffer, {
    token,
    pointer: BigInt(metadata.pointer),
    byteLength: metadata.byteLength,
  }, metadata);
  return region.buffer;
};

// ---------------------------------------------------------------------------
// Slab slices
// ---------------------------------------------------------------------------

const sliceWords = new Uint32Array(SHARED_ARRAY_BUFFER_SLICE_WORDS);

// Only views the slab pool minted travel as slices. Any other view over a pinned
// SAB keeps copying: aliasing a buffer its owner may still write would be a
// silent behaviour change, not an optimisation.
const sliceViews = new WeakSet<object>();

export const markSharedSliceView = (view: Uint8Array): Uint8Array => {
  sliceViews.add(view);
  return view;
};

export const isSharedSliceView = (value: object): boolean =>
  sliceViews.has(value);

// The worker installs this once its slab pool exists. It is how an ordinary
// `Uint8Array` return becomes a slab return: the bytes are copied into a slab
// whose slice is then shipped by pointer. Unset on the host, so arguments
// travelling host -> worker are never rewritten.
let sliceUpgrade: ((view: Uint8Array) => Uint8Array | undefined) | undefined;

export const setSharedSliceUpgrade = (
  upgrade: ((view: Uint8Array) => Uint8Array | undefined) | undefined,
): void => {
  sliceUpgrade = upgrade;
};

/**
 * A slab-backed copy of `view`, or `undefined` when this side has no pool, the
 * payload does not qualify, or the pool is out of budget.
 *
 * The copy is what makes the slab safe to alias: the slab region handed to the
 * host is overwritten in full with the returned bytes, so it can never expose
 * whatever the previous return left there.
 */
export const upgradeToSharedSlice = (
  view: Uint8Array,
): Uint8Array | undefined => sliceUpgrade?.(view);

/**
 * Detach every slab alias adopted on `transportKey`, so views already handed to
 * user code throw instead of reading a dead worker's memory.
 *
 * `adoptShared` returns a non-owning alias over the worker's slab on all three
 * runtimes (`isShared: false`), so the alias is a detachable ArrayBuffer and one
 * detach per token neutralises every view over it at once. Returns how many
 * aliases were detached.
 */
export const revokeSharedSlices = (
  transportKey: object,
  runtime: BufferReferenceRuntime,
): number => {
  releaseByTransport.delete(transportKey);
  const cache = adoptedByTransport.get(transportKey);
  if (cache === undefined) return 0;

  let detached = 0;
  for (const buffer of cache.values()) {
    // A real SharedArrayBuffer cannot be detached; it also cannot dangle,
    // because the host holds a genuine reference to it.
    if (isSharedArrayBufferValue(buffer)) continue;
    try {
      if (detachArrayBufferBestEffort(runtime, buffer as ArrayBuffer)) {
        detached++;
      }
    } catch {
      // best effort: a runtime with no detach path leaves the alias readable
    }
  }
  cache.clear();
  adoptedByTransport.delete(transportKey);
  return detached;
};

/**
 * Numeric frame for `byteLength` bytes at `byteOffset` inside a pinned slab, or
 * `undefined` when the buffer was never pinned for slice transport.
 */
export const sharedSliceNumericWords = (
  buffer: object,
  byteOffset: number,
  byteLength: number,
  transportKey?: object,
): ArrayLike<number> | undefined => {
  const pin = pinnedBySab.get(buffer as SharedArrayBuffer);
  if (pin === undefined) return undefined;
  if (byteOffset < 0 || byteLength < 0) return undefined;
  if (byteOffset + byteLength > pin.byteLength) return undefined;

  const [tokenLow, tokenHigh] = splitU64(pin.token);
  const warmTokens = getWarmTokens(transportKey);
  if (warmTokens !== undefined && warmTokens.has(pin.token)) {
    sliceWords[0] = tokenLow;
    sliceWords[1] = tokenHigh;
    sliceWords[2] = byteOffset >>> 0;
    sliceWords[3] = byteLength >>> 0;
    return sliceWords.subarray(0, SHARED_ARRAY_BUFFER_SLICE_TOKEN_WORDS);
  }

  if (pin.byteLength > 0xffffffff) return undefined;
  const [pointerLow, pointerHigh] = splitU64(pin.pointer);
  sliceWords[0] = tokenLow;
  sliceWords[1] = tokenHigh;
  sliceWords[2] = pointerLow;
  sliceWords[3] = pointerHigh;
  sliceWords[4] = pin.byteLength >>> 0;
  sliceWords[5] = encodeRuntime(RUNTIME);
  sliceWords[6] = getProcessId() >>> 0;
  sliceWords[7] = 0;
  sliceWords[8] = byteOffset >>> 0;
  sliceWords[9] = byteLength >>> 0;
  warmTokens?.add(pin.token);
  return sliceWords;
};

type SliceRelease = { readonly release: (token: bigint) => void; readonly token: bigint };

// One publisher per return lane: a slab token only means anything to the worker
// that minted it, and the lane is what identifies that worker.
const releaseByTransport = new WeakMap<object, (token: bigint) => void>();

const sliceFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry<SliceRelease>(({ release, token }) => {
    try {
      release(token);
    } catch {
      // best effort: a dead worker has nothing to reclaim
    }
  })
  : undefined;

/** Host: route finished slab tokens for `transportKey` back to their worker. */
export const setSharedSliceReleaser = (
  transportKey: object,
  release: (token: bigint) => void,
): void => {
  releaseByTransport.set(transportKey, release);
};

const decodeSlice = (
  words: ArrayLike<number>,
  transportKey?: object,
): Uint8Array => {
  const warm = words.length === SHARED_ARRAY_BUFFER_SLICE_TOKEN_WORDS;
  const token = joinU64(words[0] ?? 0, words[1] ?? 0);
  const byteOffset = (warm ? words[2] : words[8]) ?? 0;
  const byteLength = (warm ? words[3] : words[9]) ?? 0;

  const cache = adoptedCacheFor(transportKey);
  let buffer = cache.get(token);
  if (buffer === undefined) {
    if (warm) {
      throw new TypeError("SharedArrayBuffer slice cache miss for warm token");
    }
    buffer = materializeSharedBuffer(
      {
        kind: SHARED_ARRAY_BUFFER_CODEC_ID,
        origin: `${decodeRuntime(words[5] ?? 0) ?? RUNTIME}:${
          (words[6] ?? 0) >>> 0
        }`,
        runtime: decodeRuntime(words[5] ?? 0) ?? RUNTIME,
        pointer: joinU64(words[2] ?? 0, words[3] ?? 0).toString(),
        token: token.toString(),
        byteLength: words[4] ?? 0,
      },
      false,
      transportKey,
    );
  }

  const view = new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength);
  // The slab stays checked out until this view is unreachable; only then may the
  // worker refill it. No release path means the slab is simply never reused.
  const release = transportKey === undefined
    ? undefined
    : releaseByTransport.get(transportKey);
  if (release !== undefined) {
    sliceFinalizer?.register(view, { release, token });
  }
  return view;
};

const decode = (
  metadata: unknown,
  transportKey?: object,
): ArrayBuffer | SharedArrayBuffer => {
  if (!isSharedArrayBufferMetadata(metadata)) {
    throw new TypeError("Invalid SharedArrayBuffer payload metadata");
  }
  return materializeSharedBuffer(metadata, false, transportKey);
};

const decodeNumeric = (
  words: ArrayLike<number>,
  transportKey?: object,
): ArrayBuffer | SharedArrayBuffer | Uint8Array => {
  if (
    words.length === SHARED_ARRAY_BUFFER_SLICE_WORDS ||
    words.length === SHARED_ARRAY_BUFFER_SLICE_TOKEN_WORDS
  ) {
    return decodeSlice(words, transportKey);
  }
  if (words.length === SHARED_ARRAY_BUFFER_TOKEN_NUMERIC_WORDS) {
    const token = joinU64(words[0] ?? 0, words[1] ?? 0);
    const cached = adoptedCacheFor(transportKey).get(token);
    if (cached !== undefined) return cached;
    throw new TypeError("SharedArrayBuffer cache miss for warm token payload");
  }

  const runtime = decodeRuntime(words[5] ?? 0);
  if (runtime === undefined) {
    throw new TypeError("Invalid SharedArrayBuffer numeric runtime");
  }

  const originPid = words[6];
  if (
    originPid === undefined ||
    !Number.isInteger(originPid) ||
    originPid < 0
  ) {
    throw new TypeError("Invalid SharedArrayBuffer numeric origin");
  }

  if (words.length !== SHARED_ARRAY_BUFFER_NUMERIC_WORDS) {
    throw new TypeError("Invalid SharedArrayBuffer numeric word count");
  }

  const metadata: SharedArrayBufferMetadata = {
    kind: SHARED_ARRAY_BUFFER_CODEC_ID,
    origin: `${runtime}:${originPid >>> 0}`,
    runtime,
    pointer: joinU64(words[2] ?? 0, words[3] ?? 0).toString(),
    token: joinU64(words[0] ?? 0, words[1] ?? 0).toString(),
    byteLength: words[4] ?? 0,
  };

  return materializeSharedBuffer(metadata, false, transportKey);
};

const codecGlobal = globalThis as typeof globalThis & {
  __KNITTING_PAYLOAD_CODECS__?: Record<
    string,
    {
      decode: (metadata: unknown, transportKey?: object) => unknown;
      decodeNumeric?: (
        metadata: ArrayLike<number>,
        transportKey?: object,
      ) => unknown;
    } | undefined
  >;
};

const codecs = codecGlobal.__KNITTING_PAYLOAD_CODECS__ ??= Object.create(
  null,
) as NonNullable<typeof codecGlobal.__KNITTING_PAYLOAD_CODECS__>;

codecs[SHARED_ARRAY_BUFFER_CODEC_ID] = { decode, decodeNumeric };
