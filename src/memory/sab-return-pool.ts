import { createSharedArrayBuffer } from "../common/runtime.ts";
import {
  markSharedSliceView,
  pinSharedSlab,
} from "../connections/shared-array-buffer-payload.ts";
import {
  createSabReleaseConsumer,
  type SabReleaseConsumer,
} from "./sab-release-ring.ts";
import type { SharedBufferSource } from "../common/shared-buffer-region.ts";

// Worker-side pool of pinned SharedArrayBuffer slabs used to hand large returns
// to the host by reference instead of copying them through the payload arena.
//
// A slab is pinned exactly once and keeps its token for the life of the process,
// so the host's warm-token cache adopts each slab a single time and every later
// return over that slab costs four header words and no FFI. Recycling a slab
// never unpins it; it only marks it refillable.
//
// Two ways to decide when a slab is refillable:
//
//   "gc"    the host registers its view with a FinalizationRegistry and posts
//           the token back over the release ring. Exact — a slab is never
//           refilled while the host can still read it — but reclamation runs at
//           GC latency, which is unrelated to the call rate, so under a load
//           that makes little host garbage the pool starves and returns fall
//           back to copying.
//   "ring"  each size class cycles a fixed ring of slabs, so a slab is refilled
//           after `ringSlabs` further returns on this lane. Reclamation tracks
//           the call rate by construction and costs nothing, but it makes the
//           returned view *borrowed*: it is only valid until `ringSlabs` more
//           results arrive, and a consumer that retains it past that reads
//           another call's bytes.

/**
 * Smallest return that borrows a slab.
 *
 * Measured, not chosen: below ~16 KiB the copy path wins. Reclamation is driven
 * by the host's GC, small payloads make almost no host garbage, so the pool has
 * to keep minting slabs — and a fresh slab costs an mmap, an FFI pin and a cold
 * adopt on the host, all of which dwarf memcpy-ing a few KiB.
 */
export const SAB_SLAB_MIN_BYTES = 16 * 1024;

/**
 * Smallest *ordinary* return that gets copied into a slab.
 *
 * Higher than `SAB_SLAB_MIN_BYTES`, and deliberately so: `sharedBytes` builds
 * the payload in the slab and copies nothing, while upgrading an ordinary array
 * adds a worker-side memcpy to buy the host's copy-out. That trade only starts
 * paying at a size where the host's copy dominates.
 *
 * Measured on a 4-core laptop against an identical-arms control, 3 runs, median
 * of medians. At 16 KiB the upgrade is a real regression on node at 4 threads
 * (0.70/0.72/0.75x, against a 0.87-0.99x control); at 256 KiB bun gains ~2x and
 * node is neutral; at 1 MiB both gain. So the copy-out only wins clearly from a
 * few hundred KiB up, and below that the arena copy is already cheap enough.
 */
export const SAB_UPGRADE_MIN_BYTES = 256 * 1024;

export type SabSlab = {
  readonly sab: SharedArrayBuffer;
  readonly bytes: Uint8Array;
  readonly token: bigint;
  readonly pointer: bigint;
  readonly sizeClass: number;
};

/** How the pool decides a slab may be refilled. See the note above. */
export type SabReclaimMode = "gc" | "ring";

export type SabReturnPoolOptions = {
  /** Reclamation discipline. Defaults to `"ring"`. */
  reclaim?: SabReclaimMode;
  /**
   * Ring mode only: slabs cycled per size class. Must exceed the peak number of
   * results a consumer holds at once, or views alias.
   */
  ringSlabs?: number;
  /** Returns at or above this many bytes borrow a slab. */
  minBytes?: number;
  /**
   * Smallest ordinary `Uint8Array` return copied into a slab. Defaults to
   * `SAB_UPGRADE_MIN_BYTES`; must be at least `minBytes`.
   */
  upgradeMinBytes?: number;
  /** Largest return that may borrow a slab; bigger ones fall back to a copy. */
  maxBytes?: number;
  /** Live slab bytes per size class. Defaults to `SAB_CLASS_BUDGET_BYTES`. */
  classBudgetBytes?: number;
  /** Total slab bytes this worker may hold. Defaults to `SAB_POOL_BUDGET_BYTES`. */
  poolBudgetBytes?: number;
  /** Ring the host publishes finished slab tokens on. */
  releaseRing?: SharedBufferSource;
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Slab runway, as bytes rather than slab counts.
 *
 * A slab stays checked out until the host's view over it is collected, so the
 * pool needs roughly `in-flight x GC latency / call interval` live slabs to stay
 * ahead; past that, returns quietly fall back to the copy path. Both caps are
 * load bearing: the per-class budget is the runway a single size actually needs
 * (measured, a flat slab count starves large payloads and a per-class budget
 * alone lets a multi-size workload multiply the ceiling by the class count), and
 * the pool budget is the ceiling that keeps that bounded.
 */
export const SAB_CLASS_BUDGET_BYTES = 32 * 1024 * 1024;
export const SAB_POOL_BUDGET_BYTES = 64 * 1024 * 1024;

/** Ring depth per size class. Well past the 32 slots a lane can have in flight. */
export const SAB_RING_SLABS = 64;

/** Smallest power of two >= `bytes`, floored at the slab minimum. */
const sizeClassFor = (bytes: number): number => {
  let size = SAB_SLAB_MIN_BYTES;
  while (size < bytes) size <<= 1;
  return size;
};

export const createSabReturnPool = ({
  reclaim = "ring",
  ringSlabs = SAB_RING_SLABS,
  minBytes = SAB_SLAB_MIN_BYTES,
  upgradeMinBytes = SAB_UPGRADE_MIN_BYTES,
  maxBytes = DEFAULT_MAX_BYTES,
  classBudgetBytes = SAB_CLASS_BUDGET_BYTES,
  poolBudgetBytes = SAB_POOL_BUDGET_BYTES,
  releaseRing,
}: SabReturnPoolOptions = {}) => {
  const threshold = Math.max(minBytes | 0, 1);
  const upgradeThreshold = Math.max(upgradeMinBytes | 0, threshold);
  const ceiling = Math.max(maxBytes | 0, threshold);
  let poolBytes = 0;
  const classBytes = new Map<number, number>();
  // Ring mode: one cycling ring per size class, no free list and no releases.
  const ringByClass = new Map<number, { slabs: SabSlab[]; next: number }>();

  const acquireFromRing = (sizeClass: number): SabSlab | undefined => {
    let ring = ringByClass.get(sizeClass);
    if (ring === undefined) {
      ring = { slabs: [], next: 0 };
      ringByClass.set(sizeClass, ring);
    }
    if (ring.slabs.length < ringSlabs) {
      if (poolBytes + sizeClass > poolBudgetBytes) {
        // Nothing minted yet and no budget left: fall back to copying.
        if (ring.slabs.length === 0) return undefined;
      } else {
        const slab = newSlab(sizeClass);
        if (slab !== undefined) {
          ring.slabs.push(slab);
          return slab;
        }
        if (ring.slabs.length === 0) return undefined;
      }
    }
    const slab = ring.slabs[ring.next]!;
    ring.next = ring.next + 1 === ring.slabs.length ? 0 : ring.next + 1;
    return slab;
  };
  const idleByClass = new Map<number, SabSlab[]>();
  const slabsByToken = new Map<bigint, SabSlab>();
  let consumer: SabReleaseConsumer | undefined = releaseRing === undefined
    ? undefined
    : createSabReleaseConsumer(releaseRing);

  const recycle = (token: bigint): void => {
    const slab = slabsByToken.get(token);
    if (slab === undefined) return;
    const idle = idleByClass.get(slab.sizeClass);
    if (idle === undefined) idleByClass.set(slab.sizeClass, [slab]);
    else idle.push(slab);
  };

  /** Pull every slab the host has finished with back into the idle lists. */
  const drainReleases = (): number => consumer?.drain(recycle) ?? 0;

  const newSlab = (sizeClass: number): SabSlab | undefined => {
    let sab: SharedArrayBuffer;
    try {
      sab = createSharedArrayBuffer(sizeClass);
    } catch {
      return undefined;
    }
    try {
      // Share the codec's share-once pin so the slab has one token and one warm
      // entry per lane, whichever path ends up encoding it.
      const produced = pinSharedSlab(sab);
      const slab: SabSlab = {
        sab,
        bytes: new Uint8Array(sab),
        token: produced.token,
        pointer: produced.pointer,
        sizeClass,
      };
      slabsByToken.set(slab.token, slab);
      poolBytes += sizeClass;
      classBytes.set(sizeClass, (classBytes.get(sizeClass) ?? 0) + sizeClass);
      return slab;
    } catch {
      // No FFI/native pin available: the caller falls back to the copy path.
      return undefined;
    }
  };

  /**
   * A slab that can hold `byteLength`, or `undefined` when the payload does not
   * qualify, the pool is at its cap, or this runtime cannot pin a SAB.
   */
  const acquire = (byteLength: number): SabSlab | undefined => {
    if (byteLength < threshold || byteLength > ceiling) return undefined;
    const sizeClass = sizeClassFor(byteLength);
    if (reclaim === "ring") return acquireFromRing(sizeClass);

    const idle = idleByClass.get(sizeClass);
    if (idle !== undefined && idle.length > 0) return idle.pop();

    drainReleases();
    const refreshed = idleByClass.get(sizeClass);
    if (refreshed !== undefined && refreshed.length > 0) return refreshed.pop();

    if (poolBytes + sizeClass > poolBudgetBytes) return undefined;
    if ((classBytes.get(sizeClass) ?? 0) + sizeClass > classBudgetBytes) {
      return undefined;
    }
    return newSlab(sizeClass);
  };

  /**
   * A `byteLength` view over a pooled slab, or `undefined` when the caller
   * should just allocate normally. Writing the result here is what lets the host
   * take it by reference instead of copying it out of the arena.
   *
   * Zero-filled unless `zeroFill` is false. Slabs are recycled and never cleared
   * on release, so a view handed out raw still holds the previous return's
   * bytes; anything the caller does not overwrite would travel to whoever gets
   * that result. Only pass `zeroFill: false` when the caller is about to
   * overwrite all `byteLength` bytes, as the upgrade path does.
   */
  const allocate = (
    byteLength: number,
    zeroFill = true,
  ): Uint8Array | undefined => {
    const slab = acquire(byteLength);
    if (slab === undefined) return undefined;
    const view = slab.bytes.subarray(0, byteLength);
    if (zeroFill) view.fill(0);
    return markSharedSliceView(view);
  };

  const setReleaseRing = (ring: SharedBufferSource): void => {
    consumer = createSabReleaseConsumer(ring);
  };

  return {
    acquire,
    allocate,
    /** Smallest ordinary return worth copying into a slab. */
    get upgradeMinBytes(): number {
      return upgradeThreshold;
    },
    drainReleases,
    setReleaseRing,
    /** Test seam: force a token back into the idle set without the ring. */
    recycle,
    get enabled(): boolean {
      return consumer !== undefined;
    },
    get stats() {
      let idle = 0;
      for (const slabs of idleByClass.values()) idle += slabs.length;
      return { slabs: slabsByToken.size, idle, bytes: poolBytes, reclaim };
    },
  };
};

export type SabReturnPool = ReturnType<typeof createSabReturnPool>;
