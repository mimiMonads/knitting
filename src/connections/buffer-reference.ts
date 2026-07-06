import { RUNTIME } from "../common/runtime.ts";
import { getNodeProcess } from "../common/node-compat.ts";
import { RUNTIME_IS_MAIN_THREAD } from "../common/worker-runtime.ts";
import { loadNodeBufferPointerAddon } from "./node-buffer-pointer.ts";
import {
  type AdoptedRegion,
  type BufferReferenceRuntime,
  getBufferReferenceCapabilities,
} from "./buffer-reference-native.ts";

export type { BufferReferenceRuntime } from "./buffer-reference-native.ts";

export const BUFFER_REFERENCE_KIND = "knitting.bufferReference" as const;

/** Named values for the `unsafe.BufferReferenceReturn` pool option. */
export const BufferReferenceReturn = {
  /** Safe default: Deno/Bun copy the returned bytes so they outlive the worker. */
  Copy: "copy",
  /** Zero-copy: borrow the worker's backing store until the reference is released. */
  Borrow: "borrow",
} as const;

export type BufferReferenceReturn =
  (typeof BufferReferenceReturn)[keyof typeof BufferReferenceReturn];
export const BUFFER_REFERENCE_NUMERIC_TRANSFER = Symbol.for(
  "knitting.bufferReference.numericTransfer",
);
export const BUFFER_REFERENCE_RETURN_RELEASE_TOKEN = Symbol.for(
  "knitting.bufferReference.returnReleaseToken",
);

const EXTERNAL_PAYLOAD_BRAND = Symbol.for("knitting.payloadCodec");
export const BUFFER_REFERENCE_CODEC_ID = BUFFER_REFERENCE_KIND;
const BUFFER_REFERENCE_RETURN_RELEASE_MESSAGE_KEY =
  "__knittingBufferReferenceRelease";

export type BufferReferenceNumericMetadata = readonly [
  pointerLow: number,
  pointerHigh: number,
  tokenLow: number,
  tokenHigh: number,
  byteOffset: number,
  byteLength: number,
  runtime: number,
  originPid: number,
];

export type BufferReferenceMetadata = {
  readonly kind: typeof BUFFER_REFERENCE_KIND;
  readonly origin: string;
  readonly runtime: BufferReferenceRuntime;
  readonly pointer: string;
  /** Producer-side release handle (process-local). */
  readonly token: string;
  readonly byteOffset: number;
  readonly byteLength: number;
};

export type BufferReferenceReturnReleaseMessage = {
  readonly [BUFFER_REFERENCE_RETURN_RELEASE_MESSAGE_KEY]: string;
};

type BufferReferenceReturnReleaser = (token: bigint) => void;

/** Host-side hooks for borrowed returns: release channel plus shutdown tracking. */
export type BufferReferenceReturnHooks = {
  /** Ask the producing worker to drop its pin for `token`. */
  release: BufferReferenceReturnReleaser;
  /**
   * Record a borrowed reference so the pool can revoke it before its worker
   * dies. Called at claim time without `aliasBuffer`, then again on first
   * materialize with the alias buffer once it exists.
   */
  track?: (
    ref: BufferReference,
    token: bigint,
    aliasBuffer?: ArrayBuffer,
  ) => void;
};

type BufferSource = ArrayBufferView | ArrayBuffer;
type BufferReferenceTransportFinalizer = (() => void) & {
  [BUFFER_REFERENCE_RETURN_RELEASE_TOKEN]?: bigint;
};

const getRuntime = (): BufferReferenceRuntime => {
  if (RUNTIME === "deno" || RUNTIME === "bun" || RUNTIME === "node") {
    return RUNTIME;
  }
  throw new Error(`BufferReference cannot run in runtime "${RUNTIME}"`);
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
const NUMERIC_WORD_MASK = 0xffffffffn;
const RUNTIME_NODE = 1;
const RUNTIME_DENO = 2;
const RUNTIME_BUN = 3;

const PAYLOAD_TRANSPORT_FINALIZER = Symbol.for(
  "knitting.payloadCodec.transportFinalizer",
);
let currentReturnHooks: BufferReferenceReturnHooks | undefined;
const bufferReferenceInstances = new WeakSet<object>();

const encodeRuntime = (runtime: BufferReferenceRuntime): number => {
  switch (runtime) {
    case "node":
      return RUNTIME_NODE;
    case "deno":
      return RUNTIME_DENO;
    case "bun":
      return RUNTIME_BUN;
  }
};

const decodeRuntime = (runtime: number): BufferReferenceRuntime | undefined => {
  switch (runtime) {
    case RUNTIME_NODE:
      return "node";
    case RUNTIME_DENO:
      return "deno";
    case RUNTIME_BUN:
      return "bun";
    default:
      return undefined;
  }
};

const splitU64 = (value: bigint): readonly [low: number, high: number] => [
  Number(value & NUMERIC_WORD_MASK) >>> 0,
  Number((value >> 32n) & NUMERIC_WORD_MASK) >>> 0,
];

const joinU64 = (low: number, high: number): bigint =>
  (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);

const readOriginPid = (origin: string): number | undefined => {
  const separator = origin.indexOf(":");
  if (separator < 0) return undefined;
  const pid = Number(origin.slice(separator + 1));
  return Number.isInteger(pid) && pid >= 0 && pid <= 0xffffffff
    ? pid >>> 0
    : undefined;
};

const numericMetadataToMetadata = (
  words: ArrayLike<number>,
): BufferReferenceMetadata => {
  const runtime = decodeRuntime(words[6] ?? 0);
  if (runtime === undefined) {
    throw new TypeError("Invalid BufferReference numeric runtime");
  }
  const originPid = words[7];
  if (
    originPid === undefined ||
    !Number.isInteger(originPid) ||
    originPid < 0
  ) {
    throw new TypeError("Invalid BufferReference numeric origin");
  }
  return {
    kind: BUFFER_REFERENCE_KIND,
    origin: `${runtime}:${originPid >>> 0}`,
    runtime,
    pointer: joinU64(words[0] ?? 0, words[1] ?? 0).toString(),
    token: joinU64(words[2] ?? 0, words[3] ?? 0).toString(),
    byteOffset: words[4] ?? 0,
    byteLength: words[5] ?? 0,
  };
};

const toReturnHooks = (
  releaser: BufferReferenceReturnReleaser | BufferReferenceReturnHooks,
): BufferReferenceReturnHooks =>
  typeof releaser === "function" ? { release: releaser } : releaser;

export const withBufferReferenceReturnReleaser = <T>(
  releaser:
    | BufferReferenceReturnReleaser
    | BufferReferenceReturnHooks
    | undefined,
  run: () => T,
): T => {
  if (releaser === undefined) return run();
  const previous = currentReturnHooks;
  currentReturnHooks = toReturnHooks(releaser);
  try {
    return run();
  } finally {
    currentReturnHooks = previous;
  }
};

export const createBufferReferenceReturnReleaseMessage = (
  token: bigint,
): BufferReferenceReturnReleaseMessage => ({
  [BUFFER_REFERENCE_RETURN_RELEASE_MESSAGE_KEY]: token.toString(),
});

export const readBufferReferenceReturnReleaseMessage = (
  value: unknown,
): bigint | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[
    BUFFER_REFERENCE_RETURN_RELEASE_MESSAGE_KEY
  ];
  if (typeof raw !== "string") return undefined;
  try {
    const token = BigInt(raw);
    return token > 0n ? token : undefined;
  } catch {
    return undefined;
  }
};

// Backstop for references that never flow through the transport. The held
// value is a shared countdown over the reference AND every alias buffer it
// materialized: views strongly reference their buffer, so the pin can only
// drop once no view can reach the bytes.
type ProducerBackstop = {
  count: number;
  token: bigint;
  release: (token: bigint) => void;
};

const producerFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry<ProducerBackstop>((backstop) => {
    backstop.count -= 1;
    if (backstop.count > 0) return;
    try {
      backstop.release(backstop.token);
    } catch {
      // best effort
    }
  })
  : undefined;

const borrowedReturnFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry<
    { token: bigint; release: BufferReferenceReturnReleaser }
  >(
    ({ token, release }) => {
      try {
        release(token);
      } catch {
        // best effort
      }
    },
  )
  : undefined;

const isSharedArrayBufferInstance = (
  value: unknown,
): value is SharedArrayBuffer =>
  typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;

const assertMovableSource = (source: BufferSource): void => {
  if (isSharedArrayBufferInstance(source)) {
    throw new TypeError(
      "BufferReference expects ArrayBuffer memory; SharedArrayBuffer is already shared and cannot be detached",
    );
  }
  if (ArrayBuffer.isView(source)) {
    if (isSharedArrayBufferInstance(source.buffer)) {
      throw new TypeError(
        "BufferReference expects ArrayBuffer-backed views; SharedArrayBuffer is already shared and cannot be detached",
      );
    }
    return;
  }
  if (!(source instanceof ArrayBuffer)) {
    throw new TypeError(
      "BufferReference expects an ArrayBuffer or typed-array view",
    );
  }
};

type TransferableArrayBuffer = ArrayBuffer & {
  readonly detached?: boolean;
  transfer?: (newByteLength?: number) => ArrayBuffer;
  transferToFixedLength?: (newByteLength?: number) => ArrayBuffer;
};

const isDetached = (buffer: ArrayBuffer): boolean =>
  (buffer as TransferableArrayBuffer).detached === true ||
  buffer.byteLength === 0;

/** Revocation primitive: detach `buffer` so every view over it is neutralized. */
export const detachArrayBufferBestEffort = (
  runtime: BufferReferenceRuntime,
  buffer: ArrayBuffer,
): boolean => {
  if (isDetached(buffer)) return true;

  if (runtime === "node") {
    try {
      return loadNodeBufferPointerAddon().detachArrayBuffer(buffer);
    } catch {
      // fall through to the JS detach paths
    }
  }

  const transferable = buffer as TransferableArrayBuffer;
  try {
    if (typeof transferable.transferToFixedLength === "function") {
      transferable.transferToFixedLength(0);
      return isDetached(buffer);
    }
    if (typeof transferable.transfer === "function") {
      transferable.transfer(0);
      return isDetached(buffer);
    }
  } catch {
    // fall through
  }

  try {
    if (typeof structuredClone === "function") {
      structuredClone(buffer, { transfer: [buffer] });
      return isDetached(buffer);
    }
  } catch {
    // give up
  }

  return false;
};

export const isBufferReferenceMetadata = (
  value: unknown,
): value is BufferReferenceMetadata => {
  if (value === null || typeof value !== "object") return false;
  const meta = value as Partial<BufferReferenceMetadata>;
  return (
    meta.kind === BUFFER_REFERENCE_KIND &&
    typeof meta.origin === "string" &&
    (meta.runtime === "node" || meta.runtime === "deno" ||
      meta.runtime === "bun") &&
    typeof meta.pointer === "string" &&
    typeof meta.token === "string" &&
    typeof meta.byteOffset === "number" &&
    Number.isInteger(meta.byteOffset) &&
    meta.byteOffset >= 0 &&
    typeof meta.byteLength === "number" &&
    Number.isInteger(meta.byteLength) &&
    meta.byteLength >= 0
  );
};

/**
 * Zero-copy handle for moving ArrayBuffer bytes to/from **thread** workers.
 *
 * Construction detaches the source. Consumers materialize the moved region in
 * their isolate: owning on Node, alias/copy on Deno/Bun. Return a
 * `BufferReference` for large binary results to avoid copying back through the
 * transport. Use `ProcessSharedBuffer` across process boundaries.
 */
export class BufferReference {
  readonly [EXTERNAL_PAYLOAD_BRAND] = BUFFER_REFERENCE_CODEC_ID;
  readonly runtime: BufferReferenceRuntime;
  readonly origin: string;
  readonly pointer: bigint;
  readonly byteOffset: number;
  readonly byteLength: number;

  #token: bigint;
  #isProducer: boolean;
  #finalizerToken: object | undefined;
  #producerBackstop: ProducerBackstop | undefined;
  #materializedRegions: AdoptedRegion[] | undefined;
  #owned: AdoptedRegion | undefined;
  #borrowedReturnReleaser: BufferReferenceReturnReleaser | undefined;
  #borrowedReturnTrack: BufferReferenceReturnHooks["track"];
  #borrowedReturnFinalizerToken: object | undefined;
  #transportRefs = 0;
  #released = false;

  constructor(source: BufferSource);
  constructor(source: BufferSource | undefined, meta: BufferReferenceMetadata);
  constructor(
    source: BufferSource | undefined,
    meta?: BufferReferenceMetadata,
  ) {
    if (meta !== undefined) {
      // Consumer side: rebuilt from metadata, materializes via the pointer/token.
      this.runtime = meta.runtime;
      this.origin = meta.origin;
      this.pointer = BigInt(meta.pointer);
      this.byteOffset = meta.byteOffset;
      this.byteLength = meta.byteLength;
      this.#token = BigInt(meta.token);
      this.#isProducer = false;
      bufferReferenceInstances.add(this);
      return;
    }

    if (source === undefined) {
      throw new TypeError("BufferReference requires a buffer source");
    }

    assertMovableSource(source);

    const caps = getBufferReferenceCapabilities();
    const produced = caps.produce(source); // detaches the source

    this.runtime = getRuntime();
    this.origin = PROCESS_ORIGIN;
    this.pointer = produced.pointer;
    this.byteOffset = produced.byteOffset;
    this.byteLength = produced.byteLength;
    this.#token = produced.token;
    this.#isProducer = true;
    bufferReferenceInstances.add(this);

    if (producerFinalizer !== undefined) {
      this.#finalizerToken = {};
      this.#producerBackstop = {
        count: 1,
        token: this.#token,
        release: caps.release,
      };
      producerFinalizer.register(
        this,
        this.#producerBackstop,
        this.#finalizerToken,
      );
    }
  }

  static fromMetadata(meta: BufferReferenceMetadata): BufferReference {
    if (!isBufferReferenceMetadata(meta)) {
      throw new TypeError("Invalid BufferReferenceMetadata");
    }
    return new BufferReference(undefined, meta);
  }

  toMetadata(): BufferReferenceMetadata {
    this.#assertActive();
    return {
      kind: BUFFER_REFERENCE_KIND,
      origin: this.origin,
      runtime: this.runtime,
      pointer: this.pointer.toString(),
      token: this.#token.toString(),
      byteOffset: this.byteOffset,
      byteLength: this.byteLength,
    };
  }

  [BUFFER_REFERENCE_NUMERIC_TRANSFER]():
    | BufferReferenceNumericMetadata
    | undefined {
    this.#assertActive();
    const originPid = readOriginPid(this.origin);
    if (
      originPid === undefined ||
      this.byteOffset > 0xffffffff ||
      this.byteLength > 0xffffffff
    ) {
      return undefined;
    }

    const [pointerLow, pointerHigh] = splitU64(this.pointer);
    const [tokenLow, tokenHigh] = splitU64(this.#token);
    return [
      pointerLow,
      pointerHigh,
      tokenLow,
      tokenHigh,
      this.byteOffset >>> 0,
      this.byteLength >>> 0,
      encodeRuntime(this.runtime),
      originPid,
    ];
  }

  get isLocal(): boolean {
    return this.origin === PROCESS_ORIGIN && this.runtime === RUNTIME;
  }

  #assertLocal(): void {
    if (this.origin !== PROCESS_ORIGIN) {
      throw new Error(
        `BufferReference cannot cross a process boundary (origin ${this.origin} ` +
          `!= ${PROCESS_ORIGIN}). Use ProcessSharedBuffer for cross-process memory.`,
      );
    }
    if (this.runtime !== RUNTIME) {
      throw new Error(
        `BufferReference runtime mismatch: produced on ${this.runtime}, ` +
          `materializing on ${RUNTIME}.`,
      );
    }
  }

  #assertActive(): void {
    if (this.#released) {
      throw new Error("BufferReference has been released");
    }
  }

  /** Prepare a returned reference before the worker-side producer hold drains. */
  claimOwnership(
    releaser:
      | BufferReferenceReturnReleaser
      | BufferReferenceReturnHooks
      | undefined = currentReturnHooks,
  ): this {
    if (
      this.#owned !== undefined || this.#borrowedReturnReleaser !== undefined ||
      this.#released
    ) return this;
    this.#assertLocal();
    const caps = getBufferReferenceCapabilities();
    const input = {
      token: this.#token,
      pointer: this.pointer,
      byteOffset: this.byteOffset,
      byteLength: this.byteLength,
    };

    if (releaser !== undefined) {
      const hooks = toReturnHooks(releaser);
      // Borrow: adopt lazily — the alias costs GC-visible external memory on
      // FFI runtimes, so it is only created when the bytes are actually read.
      // Until then no view can exist, so the GC backstop safely watches the
      // reference itself; first materialize migrates it to the alias buffer
      // (views strongly reference their buffer, so the worker pin can only
      // drop once no view can reach the borrowed bytes).
      this.#borrowedReturnReleaser = hooks.release;
      this.#borrowedReturnTrack = hooks.track;
      this.#borrowedReturnFinalizerToken = {};
      borrowedReturnFinalizer?.register(
        this,
        { token: this.#token, release: hooks.release },
        this.#borrowedReturnFinalizerToken,
      );
      hooks.track?.(this, this.#token);
      return this;
    }

    this.#owned = caps.adopt(
      input,
      caps.supportsOwningAdopt ? undefined : { copy: true },
    );
    return this;
  }

  #materialize(): AdoptedRegion {
    this.#assertActive();
    if (this.#owned !== undefined) return this.#owned;
    this.#assertLocal();
    const region = getBufferReferenceCapabilities().adopt({
      token: this.#token,
      pointer: this.pointer,
      byteOffset: this.byteOffset,
      byteLength: this.byteLength,
    });
    if (this.#borrowedReturnReleaser !== undefined) {
      // First borrowed read: views over this alias exist from here on, so
      // move the GC backstop from the reference onto the alias buffer.
      this.#owned = region;
      if (
        this.#borrowedReturnFinalizerToken !== undefined &&
        borrowedReturnFinalizer !== undefined
      ) {
        borrowedReturnFinalizer.unregister(this.#borrowedReturnFinalizerToken);
        borrowedReturnFinalizer.register(
          region.buffer,
          { token: this.#token, release: this.#borrowedReturnReleaser },
          this.#borrowedReturnFinalizerToken,
        );
      }
      this.#borrowedReturnTrack?.(this, this.#token, region.buffer);
      return region;
    }
    (this.#materializedRegions ??= []).push(region);
    if (
      this.#producerBackstop !== undefined && producerFinalizer !== undefined
    ) {
      this.#producerBackstop.count += 1;
      producerFinalizer.register(
        region.buffer,
        this.#producerBackstop,
        this.#finalizerToken,
      );
    }
    return region;
  }

  toArrayBuffer(): ArrayBuffer {
    const region = this.#materialize();
    if (
      region.byteOffset === 0 && region.buffer.byteLength === region.byteLength
    ) {
      return region.buffer;
    }
    return region.buffer.slice(
      region.byteOffset,
      region.byteOffset + region.byteLength,
    );
  }

  toUint8Array(): Uint8Array {
    const region = this.#materialize();
    return new Uint8Array(region.buffer, region.byteOffset, region.byteLength);
  }

  /** The source is moved on construction, so it is never retained here. */
  get source(): undefined {
    return undefined;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;

    // Revoke every alias this reference handed out before any pin can drop.
    // Leak-not-UAF: if a detach fails, the pin must stay held — the GC
    // backstops remain registered and retry once the buffers are unreachable.
    let allDetached = true;

    const regions = this.#materializedRegions;
    this.#materializedRegions = undefined;
    if (regions !== undefined) {
      for (let i = 0; i < regions.length; i++) {
        allDetached =
          detachArrayBufferBestEffort(this.runtime, regions[i]!.buffer) &&
          allDetached;
      }
    }

    const borrowedReturnReleaser = this.#borrowedReturnReleaser;
    this.#borrowedReturnReleaser = undefined;
    this.#borrowedReturnTrack = undefined;
    if (borrowedReturnReleaser !== undefined) {
      const owned = this.#owned;
      this.#owned = undefined;
      if (owned !== undefined) {
        allDetached = detachArrayBufferBestEffort(this.runtime, owned.buffer) &&
          allDetached;
      }
      if (allDetached) {
        if (this.#borrowedReturnFinalizerToken !== undefined) {
          borrowedReturnFinalizer?.unregister(
            this.#borrowedReturnFinalizerToken,
          );
          this.#borrowedReturnFinalizerToken = undefined;
        }
        try {
          borrowedReturnReleaser(this.#token);
        } catch {
          // best effort
        }
      }
      // else: the finalizer stays registered on the alias buffer and sends
      // the release once every escaped view is gone.
    }

    // Only the producer owns the registry hold; consumers must not drop it.
    if (this.#isProducer && allDetached) {
      if (this.#finalizerToken !== undefined) {
        producerFinalizer?.unregister(this.#finalizerToken);
        this.#finalizerToken = undefined;
      }
      this.#producerBackstop = undefined;
      try {
        getBufferReferenceCapabilities().release(this.#token);
      } catch {
        // best effort
      }
    }
    // else on failed detach: the countdown backstop drops the pin when the
    // reference and every materialized alias are unreachable.
  }

  /**
   * Revoke a borrowed return before its producing worker goes away: detach
   * the borrowed alias so no view can dangle. With `copyBytes` the reference
   * itself survives on an owned copy; without it (worker bytes already gone)
   * later reads fail loud instead of aliasing freed memory.
   */
  revokeBorrow(copyBytes: boolean): void {
    const releaser = this.#borrowedReturnReleaser;
    if (releaser === undefined || this.#released) return;

    const owned = this.#owned;
    let nextOwned: AdoptedRegion | undefined;
    let detached = true;
    if (owned !== undefined) {
      if (copyBytes) {
        nextOwned = {
          buffer: owned.buffer.slice(
            owned.byteOffset,
            owned.byteOffset + owned.byteLength,
          ),
          byteOffset: 0,
          byteLength: owned.byteLength,
        };
      }
      // Without a copy, keep the (now detached) region so reads throw
      // instead of re-materializing an alias over freed worker memory.
      detached = detachArrayBufferBestEffort(this.runtime, owned.buffer);
    } else if (copyBytes) {
      // Never materialized: take the bytes now, while the worker still pins
      // them, so the reference stays readable after its worker dies.
      const caps = getBufferReferenceCapabilities();
      nextOwned = caps.adopt(
        {
          token: this.#token,
          pointer: this.pointer,
          byteOffset: this.byteOffset,
          byteLength: this.byteLength,
        },
        { copy: !caps.supportsOwningAdopt },
      );
    } else {
      // Never materialized and the worker bytes are already gone: no view
      // exists, so poison future reads instead of aliasing freed memory.
      this.#released = true;
    }

    if (!detached) return;

    if (nextOwned !== undefined) this.#owned = nextOwned;
    this.#borrowedReturnReleaser = undefined;
    this.#borrowedReturnTrack = undefined;
    if (this.#borrowedReturnFinalizerToken !== undefined) {
      borrowedReturnFinalizer?.unregister(this.#borrowedReturnFinalizerToken);
      this.#borrowedReturnFinalizerToken = undefined;
    }

    // Best effort: if the worker is still alive it can drop its pin early.
    try {
      releaser(this.#token);
    } catch {
      // best effort
    }
  }

  [Symbol.dispose](): void {
    this.release();
  }

  [PAYLOAD_TRANSPORT_FINALIZER](): (() => void) | undefined {
    if (this.#released) return undefined;
    this.#transportRefs++;
    let finalized = false;
    const finalizer = (() => {
      if (finalized) return;
      finalized = true;
      this.#transportRefs--;
      if (this.#transportRefs <= 0) this.release();
    }) as BufferReferenceTransportFinalizer;
    if (this.#isProducer) {
      finalizer[BUFFER_REFERENCE_RETURN_RELEASE_TOKEN] = this.#token;
    }
    return finalizer;
  }
}

export const isBufferReferenceValue = (
  value: unknown,
): value is BufferReference =>
  value !== null &&
  typeof value === "object" &&
  bufferReferenceInstances.has(value);

const codecGlobal = globalThis as typeof globalThis & {
  __KNITTING_PAYLOAD_CODECS__?: Record<
    string,
    {
      decode: (metadata: unknown) => unknown;
      decodeNumeric?: (metadata: ArrayLike<number>) => unknown;
    } | undefined
  >;
};

const codecs = codecGlobal.__KNITTING_PAYLOAD_CODECS__ ??= Object.create(
  null,
) as NonNullable<typeof codecGlobal.__KNITTING_PAYLOAD_CODECS__>;

codecs[BUFFER_REFERENCE_CODEC_ID] = {
  decode: (metadata) => {
    const ref = BufferReference.fromMetadata(
      metadata as BufferReferenceMetadata,
    );
    // Host decodes are return values; claim before the worker drains.
    // Worker decodes are forward inputs and stay lazy for the call.
    return RUNTIME_IS_MAIN_THREAD ? ref.claimOwnership() : ref;
  },
  decodeNumeric: (metadata) => {
    const ref = BufferReference.fromMetadata(
      numericMetadataToMetadata(metadata),
    );
    return RUNTIME_IS_MAIN_THREAD ? ref.claimOwnership() : ref;
  },
};
