/**
 * `KnittingSharedBuffer` -- a thread-level pool of shared byte
 * regions whose handle mimics `SharedArrayBuffer` rather than `Buffer`.
 *
 * Shape:
 *
 *   - Each thread owns one pool: its own arena SAB, its own lock sector, its
 *     own identity space. Nothing is shared between pools except the SABs a
 *     descriptor points at.
 *   - `alloc(n)` takes a region from the lazy registry
 *     (`lazy-region-registry.ts`). Identity exhaustion is not a failure: it
 *     falls back to a standalone `SharedArrayBuffer`, so the pool never blocks
 *     and never evicts a live borrow.
 *   - The **region** owns the bytes. Views are minted from it (`u8()`,
 *     `view(Ctor)`) and are plain, non-owning typed arrays. That is the same
 *     split JS already has between a `SharedArrayBuffer` and its views, and it
 *     is what keeps a `Float64Array` over the region from being silently
 *     orphaned when some unrelated `Uint8Array` over it is dropped.
 *   - The wire form is a descriptor, never bytes. A consumer thread attaches
 *     to the producer's SABs once and materializes its own region handle.
 *   - Release is one XOR into the owning lane's shared word, from whichever
 *     thread holds the last handle.
 *
 * Why GC-driven release is safe here, given the lazy registry:
 *
 *   An identity is reusable only after the owner has *observed* its release
 *   toggle (`reconcile` clears the used bit only when hostLast ^ workerBits
 *   agree). So an identity cannot be handed out again while a release for it
 *   is still outstanding, which means a late release can never apply to a
 *   newer generation -- there is no ABA to protect against with a generation
 *   counter. A forgotten handle costs one identity until the collector runs;
 *   it cannot corrupt a live region. That degradation is capacity-only, and
 *   the standalone-SAB fallback is what keeps it from turning into a stall.
 *
 *   That argument holds for exactly one releaser per identity, which is why
 *   sending a region is `moveTo()` and not `describe()`. Two releasers
 *   reintroduce the ABA the toggle cannot see: the first release lets
 *   `reconcile` recycle the identity into a new region, and the second one
 *   then frees a live stranger, whose bytes the next `alloc` hands out while
 *   it is still being read. `describe()` is inspection only.
 *
 * What it still cannot do: revoke a view that was already minted. Minting is
 * checked -- `u8()` after release throws instead of handing back a window onto
 * somebody else's recycled bytes -- but a view handed out earlier and retained
 * past release keeps aliasing the region. That is a JS limitation, not a
 * design choice, and it is why `copy()` exists.
 */

import { createLazyRegionRegistry } from "./lazy-region-registry.ts";
import {
  LOCK_SECTOR_BYTE_LENGTH,
  PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
} from "./lock.ts";
import {
  readBodyOrRefer,
  type ReadBodyOrReferOptions,
  type ReadBodyPayload,
} from "./knitting-buffer-http.ts";
import type { KnittingBody, KnittingBodyWire } from "./knitting-body.ts";

export const KNITTING_BUFFER_CODEC = "knitting.buffer";

export type KnittingBufferDescriptor =
  | {
    codec: typeof KNITTING_BUFFER_CODEC;
    kind: "region";
    lane: number;
    slot: number;
    byteOffset: number;
    byteLength: number;
  }
  | {
    codec: typeof KNITTING_BUFFER_CODEC;
    kind: "buffer";
    lane: number;
    byteLength: number;
    buffer: SharedArrayBuffer;
  };

type ViewConstructor<T extends ArrayBufferView> = new (
  buffer: ArrayBufferLike,
  byteOffset: number,
  length: number,
) => T;

/**
 * Regions may only be minted by an allocator or by adopting a descriptor.
 * Without this, user code could fabricate a region over any buffer with any
 * identity, and releasing it would XOR an identity it does not own.
 */
const MINT = Symbol("knitting.sharedBuffer.mint");

/**
 * Module-internal ownership transfer. Reachable only through the allocator's
 * `moveTo()`, which is the one place a region legitimately stops being ours.
 */
const DISOWN = Symbol("knitting.sharedBuffer.disown");

const hasSharedArrayBuffer = typeof SharedArrayBuffer === "function";

/**
 * True for a buffer that may back a standalone region, including one that has
 * crossed a transport.
 *
 * The check has to admit a plain `ArrayBuffer`. knitting ships a
 * SharedArrayBuffer by pointer and rebuilds it on the far side branded as an
 * ArrayBuffer, so `instanceof SharedArrayBuffer` is false there even though the
 * memory is genuinely shared.
 */
const isTransportedBuffer = (value: unknown): value is SharedArrayBuffer =>
  (hasSharedArrayBuffer && value instanceof SharedArrayBuffer) ||
  value instanceof ArrayBuffer;

/**
 * An owned region of shared memory. Mints views; does not pretend to be one.
 *
 * Exported for `instanceof` and for typing. It is not constructible: regions
 * come from `createKnittingAllocator().alloc()` or from adopting a descriptor.
 */
export class KnittingSharedBuffer {
  #buffer: SharedArrayBuffer;
  #byteOffset: number;
  #byteLength: number;
  #lane: number;
  #slot: number;
  // Takes `free`: true frees the identity, false surrenders it to a consumer.
  // Both paths must unregister the collector backstop, and only one of them
  // may toggle the shared release word.
  #release: ((free: boolean) => void) | undefined;
  #trim: ((byteLength: number) => void) | undefined;
  #released = false;
  #moved = false;

  // The u8 view is the common case and gets its own field; anything else goes
  // in a map that is only allocated when a second view type is asked for.
  #u8: Uint8Array | undefined;
  #views: Map<unknown, ArrayBufferView> | undefined;

  constructor(
    mint: symbol,
    buffer: SharedArrayBuffer,
    byteOffset: number,
    byteLength: number,
    lane = -1,
    slot = -1,
    release?: (free: boolean) => void,
    trim?: (byteLength: number) => void,
  ) {
    if (mint !== MINT) {
      throw new TypeError(
        "KnittingSharedBuffer is not constructible; allocate one from " +
          "createKnittingAllocator() or adopt a descriptor",
      );
    }
    this.#buffer = buffer;
    this.#byteOffset = byteOffset;
    this.#byteLength = byteLength;
    this.#lane = lane;
    this.#slot = slot;
    this.#release = release;
    this.#trim = trim;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  get byteOffset(): number {
    return this.#byteOffset;
  }

  /** Owning lane, and the region identity within it (-1 for a standalone SAB). */
  get lane(): number {
    return this.#lane;
  }

  get slot(): number {
    return this.#slot;
  }

  /** True once this handle is spent, whether by `release()` or by a move. */
  get released(): boolean {
    return this.#released;
  }

  /** True when ownership was handed to a consumer by `allocator.moveTo()`. */
  get moved(): boolean {
    return this.#moved;
  }

  /**
   * The standalone SharedArrayBuffer behind an overflow region, or undefined
   * for a pooled one.
   *
   * Pooled regions deliberately have no way to reach their backing store: it
   * is the whole arena, and handing it out would expose every other live
   * region's bytes. An overflow region owns its buffer outright, so it is the
   * only one that can travel as a buffer rather than as a descriptor.
   */
  static standaloneBufferOf(
    region: KnittingSharedBuffer,
  ): SharedArrayBuffer | undefined {
    return region.#slot === -1 ? region.#buffer : undefined;
  }

  #assertLive(): void {
    if (this.#moved) {
      throw new Error(
        "KnittingSharedBuffer: this region was moved to a consumer; it is " +
          "the consumer's to read and to release. Fill it before moveTo(), " +
          "or copy() the bytes you need to keep",
      );
    }
    if (this.#released) {
      throw new Error(
        "KnittingSharedBuffer: this region was released; mint views before " +
          "release, or copy() the bytes you need to keep",
      );
    }
  }

  /**
   * Surrender the identity without freeing it: after this the handle is inert
   * and the consumer that adopted the descriptor is the sole releaser.
   *
   * A no-op on a spent handle, so a double `moveTo()` cannot hand the same
   * identity to two consumers -- the second call throws before reaching here.
   */
  static [DISOWN](region: KnittingSharedBuffer): void {
    if (region.#released) return;
    region.#released = true;
    region.#moved = true;
    region.#u8 = undefined;
    region.#views = undefined;
    const release = region.#release;
    region.#release = undefined;
    region.#trim = undefined;
    release?.(false);
  }

  /** The byte view. Memoized: repeated calls do not construct. */
  u8(): Uint8Array {
    this.#assertLive();
    const cached = this.#u8;
    if (cached !== undefined) return cached;
    const view = new Uint8Array(
      this.#buffer as unknown as ArrayBufferLike,
      this.#byteOffset,
      this.#byteLength,
    );
    this.#u8 = view;
    mintedViews.set(view, this);
    return view;
  }

  /** A typed view over the whole region. Memoized per constructor. */
  view<T extends ArrayBufferView>(Ctor: ViewConstructor<T>): T {
    this.#assertLive();
    if ((Ctor as unknown) === Uint8Array) return this.u8() as unknown as T;

    const views = this.#views ??= new Map();
    const cached = views.get(Ctor);
    if (cached !== undefined) return cached as T;

    const perElement =
      (Ctor as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    if (this.#byteLength % perElement !== 0) {
      throw new RangeError(
        `region of ${this.#byteLength} bytes does not divide into ` +
          `${perElement}-byte elements`,
      );
    }
    const view = new Ctor(
      this.#buffer as unknown as ArrayBufferLike,
      this.#byteOffset,
      this.#byteLength / perElement,
    );
    views.set(Ctor, view);
    mintedViews.set(view, this);
    return view;
  }

  /**
   * Give back the tail of a region that was reserved larger than needed, and
   * report the region as `byteLength` bytes from here on.
   *
   * The point is streamed input of unknown length: an HTTP body with no
   * `Content-Length` cannot be sized up front, so reserve an upper bound,
   * write into it, then commit what actually arrived. Views minted before the
   * commit are dropped, because their length is now wrong.
   *
   * Shrink only. Growing would mean relocating the bytes, which is the copy
   * this whole path exists to avoid.
   */
  commit(byteLength: number): this {
    this.#assertLive();
    if (byteLength < 0 || byteLength > this.#byteLength) {
      throw new RangeError(
        `commit(${byteLength}) must be between 0 and the reserved ` +
          `${this.#byteLength} bytes`,
      );
    }
    if (byteLength === this.#byteLength) return this;
    this.#byteLength = byteLength;
    this.#u8 = undefined;
    this.#views = undefined;
    this.#trim?.(byteLength);
    return this;
  }

  /** An independently owned copy, valid after this region is released. */
  copy(): Uint8Array {
    this.#assertLive();
    return new Uint8Array(this.u8());
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#u8 = undefined;
    this.#views = undefined;
    const release = this.#release;
    this.#release = undefined;
    this.#trim = undefined;
    release?.(true);
  }

  [Symbol.dispose](): void {
    this.release();
  }
}

/**
 * Detection: given an arbitrary value on its way into a task payload, decide
 * whether it is backed by a pooled region -- in which case the codec ships a
 * descriptor instead of the bytes.
 *
 * Three strategies, cheapest first. `detectRegion` runs them in order.
 */

/** Views minted by a region, so a bare view traces back to its owner. */
const mintedViews = new WeakMap<ArrayBufferView, KnittingSharedBuffer>();

type ArenaOwner = {
  lane: number;
  slotContaining: (offset: number, byteLength: number) => number;
};

/** Arena SAB -> the pool that owns it, for views nobody minted. */
const arenaOwners = new WeakMap<object, ArenaOwner>();

/** A region handed over directly. One `instanceof`. */
export const detectByInstance = (
  value: unknown,
): KnittingSharedBuffer | undefined =>
  value instanceof KnittingSharedBuffer ? value : undefined;

/**
 * A view this pool minted. One WeakMap hit, and it never touches `.buffer` --
 * which matters because reading `.buffer` on a heap-backed typed array can
 * materialize the ArrayBuffer wrapper on first access.
 */
export const detectByMintedView = (
  value: unknown,
): KnittingSharedBuffer | undefined =>
  ArrayBuffer.isView(value) ? mintedViews.get(value) : undefined;

/**
 * Any view that lands inside a pool arena, including a `subarray` of a minted
 * view. Costs a `.buffer` read, a WeakMap hit, and a binary search over the
 * live extent table.
 */
export const detectByArena = (
  value: unknown,
): KnittingBufferDescriptor | undefined => {
  if (!ArrayBuffer.isView(value)) return undefined;
  const owner = arenaOwners.get(value.buffer as unknown as object);
  if (owner === undefined) return undefined;
  const slot = owner.slotContaining(value.byteOffset, value.byteLength);
  if (slot === -1) return undefined;
  return {
    codec: KNITTING_BUFFER_CODEC,
    kind: "region",
    lane: owner.lane,
    slot,
    byteOffset: value.byteOffset,
    byteLength: value.byteLength,
  };
};

/**
 * The full check the codec would run on a payload value. Returns a descriptor
 * to ship by reference, or undefined to serialize the value normally.
 *
 * Detection only: like `describe()`, it does not transfer ownership. Whatever
 * ships the descriptor owes the consumer one of the two safe pairings
 * documented on `describe()`.
 */
export const detectRegion = (
  value: unknown,
): KnittingBufferDescriptor | undefined => {
  const region = value instanceof KnittingSharedBuffer
    ? value
    : ArrayBuffer.isView(value)
    ? mintedViews.get(value)
    : undefined;

  if (region !== undefined) {
    return region.slot === -1
      ? {
        codec: KNITTING_BUFFER_CODEC,
        kind: "buffer",
        lane: region.lane,
        byteLength: region.byteLength,
        buffer: KnittingSharedBuffer.standaloneBufferOf(region)!,
      }
      : {
        codec: KNITTING_BUFFER_CODEC,
        kind: "region",
        lane: region.lane,
        slot: region.slot,
        byteOffset: region.byteOffset,
        byteLength: region.byteLength,
      };
  }

  return detectByArena(value);
};

/** Held value for the collector: must not reference the handle itself. */
type Hold = { free: (slot: number) => void; slot: number; live: boolean };

const finalizers = new FinalizationRegistry<Hold>((hold) => {
  if (!hold.live) return;
  hold.live = false;
  hold.free(hold.slot);
});

/**
 * Bump window, and therefore the pool's memory high-water.
 *
 * Deliberately small. A wide window makes *allocation* cheaper -- the bump
 * pointer runs longer before it has to reconcile and reclaim holes -- but that
 * only counts the bookkeeping, never the bytes. Once real traffic writes them
 * the ranking inverts: a wide window sprays consecutive regions across cold
 * memory, and the cache misses cost more than the reconcile it avoided.
 * Locality wins, so the default is a small multiple of a typical live set
 * rather than the whole arena.
 *
 * It is a default, not a recommendation: size it to `payload x in-flight`.
 * Two concurrent 1 MiB payloads do not fit here, and a reservation the window
 * cannot satisfy takes the overflow path rather than waiting. `stats()`
 * reports `overflows` precisely so this is visible instead of mysterious.
 */
export const DEFAULT_ARENA_BYTE_LENGTH = 2 * 1024 * 1024;

export type KnittingAllocatorOptions = {
  lane?: number;
  slots?: number;
  /** Bump window; see `DEFAULT_ARENA_BYTE_LENGTH` for why small is the default. */
  arenaByteLength?: number;
  /**
   * Collector backstop for a missed release.
   *   true       register every region
   *   false      never register: a missed release leaks an identity
   *   "pressure" register only once live identities cross the watermark
   *
   * "pressure" applies the same argument as the lazy reconcile: while the pool
   * is roomy a forgotten identity costs nothing, so paying the registration
   * cost on every region to reclaim it early buys nothing. Registration starts
   * when scarcity makes reclaim worth its price. Worst case is bounded: regions handed out while
   * roomy are never registered, so at watermark w at most w of the identities
   * can be stranded before every new region becomes reclaimable.
   */
  gcBackstop?: boolean | "pressure";
  backstopWatermark?: number;
};

export const createKnittingAllocator = ({
  lane = 0,
  slots = 128,
  arenaByteLength = DEFAULT_ARENA_BYTE_LENGTH,
  gcBackstop = true,
  backstopWatermark = 0.5,
}: KnittingAllocatorOptions = {}) => {
  const lockSAB = new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH);
  const arena = new SharedArrayBuffer(arenaByteLength);
  const regions = createLazyRegionRegistry({
    slots,
    mode: "lazy",
    arenaByteLength,
    lockSector: lockSAB,
  });

  arenaOwners.set(arena as unknown as object, {
    lane,
    slotContaining: regions.slotContaining,
  });

  let overflows = 0;
  let pooled = 0;
  let live = 0;
  let registered = 0;
  const watermark = (slots * backstopWatermark) | 0;

  const alloc = (byteLength: number): KnittingSharedBuffer => {
    const slot = regions.allocRegion(byteLength);

    // Identity or arena exhausted: hand back a standalone SAB instead of
    // evicting somebody's live borrow. Costs an allocation, never a stall.
    if (slot === -1) {
      overflows++;
      return new KnittingSharedBuffer(
        MINT,
        new SharedArrayBuffer(byteLength),
        0,
        byteLength,
        lane,
        -1,
      );
    }

    pooled++;
    live++;
    const byteOffset = regions.regionStart(slot);

    const trim = (committed: number): void => {
      regions.trimRegion(slot, committed);
    };

    // Both paths back to the pool -- an explicit release and a collected
    // handle -- must run this. Freeing the identity without decrementing
    // `live` latched `gcBackstop: "pressure"` on permanently once the
    // watermark was crossed, and left `stats().live` counting handles the
    // collector had already reclaimed.
    const releaseSlot = (freed: number): void => {
      live--;
      regions.free(freed);
    };

    if (
      gcBackstop === false || (gcBackstop === "pressure" && live < watermark)
    ) {
      let held = true;
      return new KnittingSharedBuffer(
        MINT,
        arena,
        byteOffset,
        byteLength,
        lane,
        slot,
        (free: boolean) => {
          if (!held) return;
          held = false;
          if (free) releaseSlot(slot);
          else live--;
        },
        trim,
      );
    }

    const hold: Hold = { free: releaseSlot, slot, live: true };
    const region = new KnittingSharedBuffer(
      MINT,
      arena,
      byteOffset,
      byteLength,
      lane,
      slot,
      (free: boolean) => {
        if (!hold.live) return;
        hold.live = false;
        finalizers.unregister(hold);
        if (free) releaseSlot(slot);
        // A moved identity is still occupied -- by the consumer, who now owns
        // the only release. It leaves this pool's handle count either way.
        else live--;
      },
      trim,
    );
    finalizers.register(region, hold, hold);
    registered++;
    return region;
  };

  /**
   * Reserve up to `maxByteLength` for input whose real size is not known yet
   * -- a chunked HTTP body, a stream. Fill it, then `region.commit(actual)` to
   * hand the unused tail back.
   *
   * The bound must fit the bump window, and comfortably: a reservation the
   * window cannot satisfy is not an error, it takes the overflow path and
   * allocates a fresh SharedArrayBuffer, which is the most expensive thing
   * this pool can do -- orders of magnitude past a pooled allocation, not a
   * few percent. Size `arenaByteLength` to several concurrent reservations,
   * and check `stats().overflows` if throughput looks wrong.
   */
  const allocUpTo = (maxByteLength: number): KnittingSharedBuffer =>
    alloc(maxByteLength);

  /**
   * The wire form of a region, with no effect on ownership.
   *
   * Sending this to a consumer that adopts it normally leaves two independent
   * releasers on one identity -- this handle (and its collector backstop) plus
   * the consumer's -- which is the one way to defeat the toggle's ABA argument
   * and hand a live region's bytes out twice. Two safe pairings:
   *
   *   - `moveTo()` with a plain `adopt()`: the consumer owns and releases.
   *   - `describe()` with `adopt(d, { borrow: true })`: this pool keeps
   *     ownership, the consumer gets a handle that cannot release, and the
   *     region must outlive the call it is lent to.
   */
  const describe = (region: KnittingSharedBuffer): KnittingBufferDescriptor => {
    // `lane` is stamped from this pool, so a foreign region would name an
    // identity in an arena the consumer resolves against the wrong pool.
    if (region.lane !== lane) {
      throw new Error(
        `region belongs to lane ${region.lane}, not lane ${lane}`,
      );
    }
    if (region.slot === -1) {
      return {
        codec: KNITTING_BUFFER_CODEC,
        kind: "buffer",
        lane,
        byteLength: region.byteLength,
        // A SharedArrayBuffer only survives as a whole payload: knitting
        // encodes a plain object with JSON.stringify, which renders any
        // buffer nested inside it as `{}`. So this descriptor is for a
        // same-isolate handoff; to send an overflow region to another
        // thread, send `KnittingSharedBuffer.standaloneBufferOf(region)` as
        // the payload itself and `adopt` that. `adopt` rejects a descriptor
        // whose buffer did not survive rather than handing back a region over
        // the wrong memory.
        buffer: KnittingSharedBuffer.standaloneBufferOf(region)!,
      };
    }
    return {
      codec: KNITTING_BUFFER_CODEC,
      kind: "region",
      lane,
      slot: region.slot,
      byteOffset: region.byteOffset,
      byteLength: region.byteLength,
    };
  };

  /**
   * Hand a region to a consumer: returns the descriptor to send and leaves
   * this handle inert, so the consumer that adopts it is the sole releaser.
   *
   * This is the only safe way to send a region. The handle is spent on
   * return -- `u8()`, `commit()` and a second `moveTo()` all throw -- so fill
   * the region before moving it. Views minted earlier still alias the bytes;
   * that is the same limitation `release()` has, and the same answer applies
   * (`copy()` before moving if you need to keep reading).
   *
   * The identity is not freed here. It stays occupied until the consumer
   * releases it and this pool's next `reconcile()` observes the toggle.
   */
  const moveTo = (region: KnittingSharedBuffer): KnittingBufferDescriptor => {
    if (region.released) {
      throw new Error(
        region.moved
          ? "region was already moved to a consumer"
          : "region was released and cannot be moved",
      );
    }
    const descriptor = describe(region);
    KnittingSharedBuffer[DISOWN](region);
    return descriptor;
  };

  /**
   * Read a Request body and choose a pooled region or a moved
   * `BufferReference`. The default HTTP crossover is 2 MiB and can be
   * overridden per request. Regions still use the allocator descriptor when
   * they are sent to a worker; `BufferReference` can be passed directly to a
   * thread-worker call.
   *
   * `maxByteLength` is required: this path deliberately handles bodies too
   * large for the arena, so neither the pool nor the crossover implies a
   * bound, and a declared length is only ever a claim by the client.
   */
  const allocOrRefer = (
    request: Request,
    options: ReadBodyOrReferOptions,
  ): Promise<ReadBodyPayload> =>
    readBodyOrRefer(request, { alloc, arenaByteLength }, options);

  /**
   * Read a request body into one disposable handle, whichever way it travels.
   *
   * This is `allocOrRefer()` with the branch folded in: send `body.wire` to a
   * task, read `body.u8()` on the host, and dispose it when the call settles.
   * The worker resolves `wire` back to bytes with `createBodyReader()`.
   *
   * The host stays the owner for the whole call. There is no `reconcile()` to
   * remember either -- the registry reconciles when it needs identities, so a
   * released body is reclaimed by the next allocation that wants it.
   */
  const readBody = async (
    request: Request,
    options: ReadBodyOrReferOptions,
  ): Promise<KnittingBody> => {
    const payload = await allocOrRefer(request, options);

    if (!(payload instanceof KnittingSharedBuffer)) {
      // Already its own wire form: a moved reference travels as the payload.
      return {
        wire: payload,
        byteLength: payload.byteLength,
        u8: () => payload.toUint8Array(),
        release: () => payload.release(),
        [Symbol.dispose]: () => payload.release(),
      };
    }

    return {
      wire: wireFor(payload),
      byteLength: payload.byteLength,
      u8: () => payload.u8(),
      release: () => payload.release(),
      [Symbol.dispose]: () => payload.release(),
    };
  };

  /**
   * How a region travels: a descriptor when it is pooled, its own buffer when
   * it overflowed the arena.
   *
   * An overflow region owns a standalone SharedArrayBuffer, which knitting
   * preserves as a whole payload but renders as `{}` if it is nested inside
   * one -- so it cannot ride in a descriptor. It is sized to the body that was
   * *declared*; a body that arrived shorter was committed down, and the extra
   * bytes are not ours to hand out, so that case is copied to an exact buffer.
   */
  const wireFor = (region: KnittingSharedBuffer): KnittingBodyWire => {
    if (region.slot !== -1) return describe(region);

    const buffer = KnittingSharedBuffer.standaloneBufferOf(region)!;
    if (buffer.byteLength === region.byteLength) return buffer;
    const exact = new SharedArrayBuffer(region.byteLength);
    new Uint8Array(exact as unknown as ArrayBufferLike).set(region.u8());
    return exact;
  };

  return {
    lane,
    /** Bump window this pool was built with; the ceiling on a pooled region. */
    arenaByteLength,
    alloc,
    allocUpTo,
    allocOrRefer,
    readBody,
    describe,
    moveTo,
    reconcile: regions.reconcile,
    // `regions.free` is deliberately not exposed: it XORs an identity with no
    // check that the caller owns it, which would let a stray call make a live
    // identity look released and hand the same bytes out twice.
    stats: () => ({ ...regions.stats(), pooled, overflows, registered, live }),
    resetCounters: () => {
      pooled = 0;
      overflows = 0;
      registered = 0;
    },
    /** What a consumer thread needs to attach: SABs, not pointers. */
    transport: () => ({ lane, lockSAB, arena, slots, arenaByteLength }),
  };
};

export type KnittingAllocator = ReturnType<typeof createKnittingAllocator>;

/**
 * The consumer side of another thread's pool. It never allocates; it
 * materializes regions over the producer's arena and releases the producer's
 * identity with one XOR into the shared word.
 */
export const attachKnittingAllocator = (
  { lane, lockSAB, arena, slots }: {
    lane: number;
    lockSAB: SharedArrayBuffer;
    arena: SharedArrayBuffer;
    slots: number;
  },
) => {
  const words = slots >>> 5;
  const workerBits = new Int32Array(
    lockSAB,
    PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES,
    words,
  );

  // Indexed, not masked: `slots` need only be a multiple of 32, so folding
  // with `slots - 1` aliased identities onto each other whenever it was not a
  // power of two. `adopt` range-checks every descriptor before this runs.
  const free = (slot: number): void => {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= slots) {
      throw new RangeError(`region identity ${slot} outside 0..${slots - 1}`);
    }
    Atomics.xor(workerBits, slot >>> 5, (1 << (slot & 31)) | 0);
  };

  /**
   * Materialize a region over the producer's arena.
   *
   * `borrow: true` returns a handle with no release at all: `release()` is a
   * no-op and no collector backstop is registered. That is the shape for a
   * region lent for the duration of a call, where the producer stayed the
   * owner -- the identity is a single shared bit, so a consumer that releases
   * a borrowed region XORs it back to "in use" and strands it, or worse frees
   * a region the producer has since recycled. Enforcing it here is cheaper
   * than enforcing it by comment at every call site.
   */
  const adopt = (
    descriptor: KnittingBufferDescriptor | SharedArrayBuffer,
    { gcBackstop = true, borrow = false } = {},
  ): KnittingSharedBuffer => {
    // An overflow region's buffer travels on its own rather than nested in a
    // descriptor; see `describe`. It owns no identity, so there is nothing to
    // check it against and nothing to release.
    if (isTransportedBuffer(descriptor)) {
      return new KnittingSharedBuffer(
        MINT,
        descriptor,
        0,
        descriptor.byteLength,
        lane,
        -1,
      );
    }
    if (descriptor.kind === "buffer") {
      const { buffer, byteLength } = descriptor;
      if (!isTransportedBuffer(buffer)) {
        throw new TypeError(
          "descriptor of kind 'buffer' carries no buffer. A " +
            "SharedArrayBuffer nested inside a payload object does not " +
            "survive encoding; send it as the payload itself and adopt it " +
            "directly.",
        );
      }
      if (
        !Number.isSafeInteger(byteLength) || byteLength < 0 ||
        byteLength > buffer.byteLength
      ) {
        throw new RangeError(
          `descriptor claims ${byteLength} bytes of a ` +
            `${buffer.byteLength}-byte buffer`,
        );
      }
      return new KnittingSharedBuffer(
        MINT,
        buffer,
        0,
        byteLength,
        descriptor.lane,
        -1,
      );
    }
    if (descriptor.lane !== lane) {
      throw new Error(
        `descriptor for lane ${descriptor.lane} adopted on lane ${lane}`,
      );
    }

    const { slot, byteOffset, byteLength } = descriptor;

    // A descriptor is a plain object, so treat it as input. These checks stop
    // a malformed one from aliasing outside the arena or releasing an identity
    // that does not exist. They cannot stop a descriptor that points at
    // another *live* region: the extent table is owned by the producing
    // thread and is not in shared memory, so a peer has no way to check it.
    // That is why adopting is part of the transport surface and not the app
    // one -- descriptors are produced by the runtime, never by user code.
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= slots) {
      throw new RangeError(`descriptor names identity ${slot}, outside 0..${slots - 1}`);
    }
    if (
      !Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteLength) ||
      byteOffset < 0 || byteLength < 0 ||
      byteOffset + byteLength > arena.byteLength
    ) {
      throw new RangeError(
        `descriptor spans [${byteOffset}, ${byteOffset + byteLength}) ` +
          `outside the ${arena.byteLength}-byte arena`,
      );
    }
    if (borrow) {
      return new KnittingSharedBuffer(
        MINT,
        arena,
        byteOffset,
        byteLength,
        lane,
        slot,
      );
    }

    if (!gcBackstop) {
      let held = true;
      return new KnittingSharedBuffer(
        MINT,
        arena,
        byteOffset,
        byteLength,
        lane,
        slot,
        () => {
          if (!held) return;
          held = false;
          free(slot);
        },
      );
    }

    const hold: Hold = { free, slot, live: true };
    const region = new KnittingSharedBuffer(
      MINT,
      arena,
      byteOffset,
      byteLength,
      lane,
      slot,
      () => {
        if (!hold.live) return;
        hold.live = false;
        finalizers.unregister(hold);
        free(slot);
      },
    );
    finalizers.register(region, hold, hold);
    return region;
  };

  // `free` stays internal here for the same reason it does on the allocator.
  return { lane, adopt };
};
