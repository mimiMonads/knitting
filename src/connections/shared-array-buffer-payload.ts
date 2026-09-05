import { RUNTIME } from "../common/runtime.ts";
import { getNodeProcess } from "../common/node-compat.ts";
import { getBufferReferenceCapabilities } from "./buffer-reference-native.ts";
import {
  type BufferReferenceRuntime,
  detachArrayBufferBestEffort,
} from "./buffer-reference.ts";

// SharedArrayBuffer transport uses a process-local pointer and is limited to
// thread workers; SABs are not moved or detached.

export const SHARED_ARRAY_BUFFER_CODEC_ID =
  "knitting.sharedArrayBuffer" as const;
export const SHARED_ARRAY_BUFFER_NUMERIC_TRANSFER = Symbol.for(
  "knitting.sharedArrayBuffer.numericTransfer",
);
export const SHARED_ARRAY_BUFFER_NUMERIC_WORDS = 8;
const SHARED_ARRAY_BUFFER_TOKEN_NUMERIC_WORDS = 2;

// Slice frames carry an explicit length; warm frames carry only the token.

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

// Pin each SAB once and release the pin when the producer SAB is collected.
type SharedPin = { token: bigint; pointer: bigint; byteLength: number };

const pinnedBySab = new WeakMap<SharedArrayBuffer, SharedPin>();
const payloadBySharedBuffer = new WeakMap<object, SharedArrayBufferPayload>();
const warmedTokensByTransport = new WeakMap<object, Set<bigint>>();

// Tokens are isolate-local, so adopted aliases are cached per transport lane.
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
): ArrayBuffer | SharedArrayBuffer => {
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
