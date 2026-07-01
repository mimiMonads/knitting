import { RUNTIME } from "../common/runtime.ts";
import { loadNodeBufferPointerAddon } from "./node-buffer-pointer.ts";
import { getNodeFfi, isNodeFfiTarget } from "./node-ffi.ts";

export type BufferReferenceRuntime = "node" | "deno" | "bun";

/** A backing store the producer has taken exclusive ownership of (source detached). */
export type ProducedBuffer = {
  /** Producer-side release handle. */
  token: bigint;
  /** Address of the region start (view offset already applied). */
  pointer: bigint;
  /** Offset of the region inside the backing store (used by the Node owning adopt). */
  byteOffset: number;
  byteLength: number;
};

export type AdoptInput = {
  token: bigint;
  pointer: bigint;
  byteOffset: number;
  byteLength: number;
};

/** The materialized region: bytes live in `buffer` at `[byteOffset, byteOffset+byteLength)`. */
export type AdoptedRegion = {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
};

/** Materialized SAB region; `isShared` means `buffer` is a real SharedArrayBuffer. */
export type SharedAdoptedRegion = {
  buffer: SharedArrayBuffer | ArrayBuffer;
  byteOffset: number;
  byteLength: number;
  isShared: boolean;
};

export type AdoptOptions = {
  /** Copy when bytes must survive producer release on non-owning runtimes. */
  copy?: boolean;
};

type MovableBufferSource = ArrayBuffer | ArrayBufferView;

export type BufferReferenceCapabilities = {
  readonly runtime: BufferReferenceRuntime;
  /** True when `adopt` returns a buffer that co-owns the store and survives `release`. */
  readonly supportsOwningAdopt: boolean;
  /** Take exclusive ownership of `source`'s bytes, detaching the source. */
  produce(source: MovableBufferSource): ProducedBuffer;
  /** Materialize the region in the current isolate (owning on Node, alias/copy elsewhere). */
  adopt(input: AdoptInput, opts?: AdoptOptions): AdoptedRegion;
  /** Drop the producer's hold on the backing store. */
  release(token: bigint): void;
  /** True when `adoptShared` returns a real SharedArrayBuffer (Node). */
  readonly supportsSharedAdopt: boolean;
  /** Share a SharedArrayBuffer by reference (no detach — SABs persist). */
  produceShared(sab: SharedArrayBuffer): ProducedBuffer;
  /** Materialize a shared region as a non-owning alias over the same bytes. */
  adoptShared(input: AdoptInput): SharedAdoptedRegion;
  /** Drop the producer's pin on a shared buffer (JS-side; teardown-safe). */
  releaseShared(token: bigint): void;
};

type BufferLike = ArrayBuffer & {
  detached?: boolean;
  transfer?: (newByteLength?: number) => ArrayBuffer;
  transferToFixedLength?: (newByteLength?: number) => ArrayBuffer;
};

const isSharedArrayBufferInstance = (
  value: unknown,
): value is SharedArrayBuffer =>
  typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;

const assertMovableSource = (source: MovableBufferSource): void => {
  const buffer = ArrayBuffer.isView(source) ? source.buffer : source;
  if (isSharedArrayBufferInstance(buffer)) {
    throw new TypeError(
      "BufferReference expects ArrayBuffer-backed views; SharedArrayBuffer is already " +
        "shared and cannot be moved",
    );
  }
};

const readSourceRegion = (
  source: MovableBufferSource,
): { buffer: ArrayBuffer; byteOffset: number; byteLength: number } => {
  if (ArrayBuffer.isView(source)) {
    return {
      buffer: source.buffer as ArrayBuffer,
      byteOffset: source.byteOffset,
      byteLength: source.byteLength,
    };
  }
  return { buffer: source, byteOffset: 0, byteLength: source.byteLength };
};

/** Detach `buffer`, returning a fixed-length buffer over the same bytes (the move). */
const detachIntoFixedLength = (buffer: ArrayBuffer): ArrayBuffer => {
  const transferable = buffer as BufferLike;
  if (typeof transferable.transferToFixedLength === "function") {
    return transferable.transferToFixedLength();
  }
  if (typeof transferable.transfer === "function") {
    return transferable.transfer();
  }
  throw new TypeError(
    "BufferReference requires ArrayBuffer.prototype.transfer to move a buffer in this runtime",
  );
};

// ---------------------------------------------------------------------------
// Deno/Bun pin moved buffers in JS and expose non-owning FFI aliases.
// Tokens stay producer-isolate-local; consumers materialize from the pointer.
// ---------------------------------------------------------------------------

const ffiPinned = new Map<bigint, ArrayBuffer | SharedArrayBuffer>();
let nextFfiToken = 1n;

const pinTransferred = (buffer: ArrayBuffer): bigint => {
  const token = nextFfiToken++;
  ffiPinned.set(token, buffer);
  return token;
};

const pinShared = (sab: SharedArrayBuffer): bigint => {
  const token = nextFfiToken++;
  ffiPinned.set(token, sab);
  return token;
};

const releaseFfi = (token: bigint): void => {
  ffiPinned.delete(token);
};

const produceSharedFfi = (
  sab: SharedArrayBuffer,
  readPointer: (region: ArrayBufferView) => bigint,
): ProducedBuffer => {
  // SABs are shared, not detached; pin keeps producer bytes alive.
  const pointer = readPointer(new Uint8Array(sab));
  const token = pinShared(sab);
  return { token, pointer, byteOffset: 0, byteLength: sab.byteLength };
};

type DenoUnsafe = {
  UnsafePointer: {
    of: (value: ArrayBufferView) => unknown;
    value: (pointer: unknown) => bigint;
    create: (value: bigint) => unknown;
  };
  UnsafePointerView: new (pointer: unknown) => {
    getArrayBuffer: (byteLength: number, byteOffset?: number) => ArrayBuffer;
  };
};

const getDeno = (): DenoUnsafe => {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoUnsafe }).Deno;
  if (
    deno?.UnsafePointer === undefined || deno.UnsafePointerView === undefined
  ) {
    throw new Error(
      "Deno FFI (UnsafePointer) is not available in this runtime",
    );
  }
  return deno;
};

type BunFFI = {
  ptr: (view: ArrayBufferView) => number;
  toArrayBuffer: (
    pointer: number,
    byteOffset: number,
    byteLength: number,
  ) => ArrayBuffer;
};

const getBunFFI = (): BunFFI => {
  const ffi = (globalThis as typeof globalThis & {
    Bun?: { FFI?: Partial<BunFFI> };
  }).Bun?.FFI;
  if (
    typeof ffi?.ptr !== "function" || typeof ffi?.toArrayBuffer !== "function"
  ) {
    throw new Error(
      "Bun FFI (ptr/toArrayBuffer) is not available in this runtime",
    );
  }
  return ffi as BunFFI;
};

const produceFfi = (
  source: MovableBufferSource,
  readPointer: (region: ArrayBufferView) => bigint,
): ProducedBuffer => {
  assertMovableSource(source);
  const { buffer, byteOffset, byteLength } = readSourceRegion(source);
  const moved = detachIntoFixedLength(buffer);
  // Region view over the moved buffer; the pointer captures the offset.
  const region = new Uint8Array(moved, byteOffset, byteLength);
  const pointer = readPointer(region);
  const token = pinTransferred(moved);
  return { token, pointer, byteOffset, byteLength };
};

const finishAlias = (
  alias: ArrayBuffer,
  copy: boolean | undefined,
): AdoptedRegion => {
  if (copy) {
    const owned = alias.slice(0);
    return { buffer: owned, byteOffset: 0, byteLength: owned.byteLength };
  }
  return { buffer: alias, byteOffset: 0, byteLength: alias.byteLength };
};

const createDenoCapabilities = (): BufferReferenceCapabilities => {
  const deno = getDeno();
  return {
    runtime: "deno",
    supportsOwningAdopt: false,
    produce: (view) =>
      produceFfi(
        view,
        (region) => deno.UnsafePointer.value(deno.UnsafePointer.of(region)),
      ),
    adopt: ({ pointer, byteLength }, opts) => {
      const alias = denoAlias(deno, pointer, byteLength);
      return finishAlias(alias, opts?.copy);
    },
    release: releaseFfi,
    supportsSharedAdopt: false,
    produceShared: (sab) =>
      produceSharedFfi(
        sab,
        (region) => deno.UnsafePointer.value(deno.UnsafePointer.of(region)),
      ),
    adoptShared: ({ pointer, byteLength }) => {
      const alias = denoAlias(deno, pointer, byteLength);
      return { buffer: alias, byteOffset: 0, byteLength, isShared: false };
    },
    releaseShared: releaseFfi,
  };
};

const denoAlias = (
  deno: DenoUnsafe,
  pointer: bigint,
  byteLength: number,
): ArrayBuffer => {
  const handle = deno.UnsafePointer.create(pointer);
  if (handle === null || handle === undefined) {
    throw new Error("Deno.UnsafePointer.create returned null");
  }
  return new deno.UnsafePointerView(handle).getArrayBuffer(byteLength);
};

const createBunCapabilities = (): BufferReferenceCapabilities => {
  const ffi = getBunFFI();
  return {
    runtime: "bun",
    supportsOwningAdopt: false,
    produce: (view) => produceFfi(view, (region) => BigInt(ffi.ptr(region))),
    adopt: ({ pointer, byteLength }, opts) => {
      const alias = ffi.toArrayBuffer(Number(pointer), 0, byteLength);
      return finishAlias(alias, opts?.copy);
    },
    release: releaseFfi,
    supportsSharedAdopt: false,
    produceShared: (sab) =>
      produceSharedFfi(sab, (region) => BigInt(ffi.ptr(region))),
    adoptShared: ({ pointer, byteLength }) => {
      const alias = ffi.toArrayBuffer(Number(pointer), 0, byteLength);
      return { buffer: alias, byteOffset: 0, byteLength, isShared: false };
    },
    releaseShared: releaseFfi,
  };
};

const createNodeFfiCapabilities = (): BufferReferenceCapabilities => {
  const ffi = getNodeFfi();
  const readPointer = (region: ArrayBufferView): bigint =>
    ffi.getRawPointer(region);
  return {
    runtime: "node",
    supportsOwningAdopt: false,
    produce: (view) => produceFfi(view, readPointer),
    adopt: ({ pointer, byteLength }, opts) => {
      const alias = ffi.toArrayBuffer(pointer, byteLength, false);
      return finishAlias(alias, opts?.copy);
    },
    release: releaseFfi,
    supportsSharedAdopt: false,
    produceShared: (sab) => produceSharedFfi(sab, readPointer),
    adoptShared: ({ pointer, byteLength }) => {
      const alias = ffi.toArrayBuffer(pointer, byteLength, false);
      return { buffer: alias, byteOffset: 0, byteLength, isShared: false };
    },
    releaseShared: releaseFfi,
  };
};

// ---------------------------------------------------------------------------
// Node: addon-backed owning move via shared_ptr<BackingStore>.
// Older prebuilds fall back to non-owning retain/wrap.
// ---------------------------------------------------------------------------

const createNodeCapabilities = (): BufferReferenceCapabilities => {
  const addon = loadNodeBufferPointerAddon();
  const owning = typeof addon.retainBackingStore === "function" &&
    typeof addon.adoptBackingStore === "function" &&
    typeof addon.releaseBackingStore === "function";

  // SABs use JS pins plus non-owning aliases so no native handle survives teardown.
  const sharedCapabilities = {
    supportsSharedAdopt: false as const,
    produceShared: (sab: SharedArrayBuffer): ProducedBuffer =>
      produceSharedFfi(sab, (region) => addon.getPointer(region)),
    adoptShared: ({ pointer, byteLength }: AdoptInput): SharedAdoptedRegion => {
      const alias = addon.wrapPointer(pointer, byteLength);
      return { buffer: alias, byteOffset: 0, byteLength, isShared: false };
    },
    releaseShared: releaseFfi,
  };

  if (owning) {
    return {
      runtime: "node",
      supportsOwningAdopt: true,
      produce: (source) => {
        assertMovableSource(source);
        const r = addon.retainBackingStore!(source);
        return {
          token: r.token,
          pointer: r.pointer,
          byteOffset: r.byteOffset,
          byteLength: r.byteLength,
        };
      },
      adopt: ({ token, byteOffset, byteLength }, opts) => {
        const buffer = addon.adoptBackingStore!(token);
        if (opts?.copy) {
          const owned = buffer.slice(byteOffset, byteOffset + byteLength);
          return { buffer: owned, byteOffset: 0, byteLength: owned.byteLength };
        }
        return { buffer, byteOffset, byteLength };
      },
      release: (token) => void addon.releaseBackingStore!(token),
      ...sharedCapabilities,
    };
  }

  // Legacy fallback: producer pins via retainPointer, consumer wraps non-owning.
  return {
    runtime: "node",
    supportsOwningAdopt: false,
    produce: (source) => {
      assertMovableSource(source);
      const retained = addon.retainPointer(source);
      const byteOffset = ArrayBuffer.isView(source) ? source.byteOffset : 0;
      return {
        token: retained.token,
        pointer: retained.pointer,
        byteOffset,
        byteLength: retained.byteLength,
      };
    },
    adopt: ({ pointer, byteLength }, opts) => {
      const alias = addon.wrapPointer(pointer, byteLength);
      return finishAlias(alias, opts?.copy);
    },
    release: (token) => void addon.releasePointer(token),
    ...sharedCapabilities,
  };
};

let cached: BufferReferenceCapabilities | undefined;

export const getBufferReferenceCapabilities =
  (): BufferReferenceCapabilities => {
    if (cached !== undefined) return cached;
    switch (RUNTIME) {
      case "node":
        return cached = isNodeFfiTarget()
          ? createNodeFfiCapabilities()
          : createNodeCapabilities();
      case "deno":
        return cached = createDenoCapabilities();
      case "bun":
        return cached = createBunCapabilities();
      default:
        throw new Error(`BufferReference cannot run in runtime "${RUNTIME}"`);
    }
  };
