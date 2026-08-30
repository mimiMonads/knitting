import {
  createSabReturnPool,
  type SabReclaimMode,
  type SabReturnPool,
} from "../memory/sab-return-pool.ts";
import { setSharedSliceUpgrade } from "../connections/shared-array-buffer-payload.ts";
import type { SharedBufferSource } from "../common/shared-buffer-region.ts";

// Worker-facing allocator for returns the host should not have to copy.
//
// `sharedBytes(n)` hands back a view over a pinned, pooled SharedArrayBuffer.
// Returning that view ships a pointer frame instead of the bytes, so the host
// aliases the slab; the slab is reusable once the host's view is unreachable.
// Outside a pool, or when the runtime cannot pin a SAB, it degrades to a plain
// `Uint8Array` and the ordinary copy path.

let pool: SabReturnPool | undefined;

export const installSharedReturnPool = (options: {
  releaseRing: SharedBufferSource;
  reclaim?: SabReclaimMode;
  ringSlabs?: number;
  minBytes?: number;
  upgradeMinBytes?: number;
  maxBytes?: number;
  classBudgetBytes?: number;
  poolBudgetBytes?: number;
}): void => {
  pool = createSabReturnPool(options);
  setSharedSliceUpgrade(upgradeReturnToSlab);
};

/** Test seam. */
export const resetSharedReturnPool = (): void => {
  pool = undefined;
  setSharedSliceUpgrade(undefined);
};

/**
 * Copy an ordinary returned `Uint8Array` into a slab so the host can alias it.
 *
 * `zeroFill: false` is safe here and only here: `set` overwrites all
 * `byteLength` bytes of the view, so the region the host sees is exactly the
 * bytes being returned and never a previous return's remainder.
 */
const upgradeReturnToSlab = (view: Uint8Array): Uint8Array | undefined => {
  const active = pool;
  if (active === undefined || view.byteLength < active.upgradeMinBytes) {
    return undefined;
  }
  const slab = active.allocate(view.byteLength, false);
  if (slab === undefined) return undefined;
  slab.set(view);
  return slab;
};

/** Pull slabs the host has finished with back into the pool. */
export const drainSharedReturnReleases = (): number =>
  pool?.drainReleases() ?? 0;

export const sharedReturnPoolStats = (): {
  slabs: number;
  idle: number;
  bytes: number;
  reclaim: SabReclaimMode | "off";
} => pool?.stats ?? { slabs: 0, idle: 0, bytes: 0, reclaim: "off" };

/**
 * A `byteLength` buffer to build a return value in, taken from a pooled slab the
 * host can read without copying.
 *
 * The view is zero-filled, so a partial write returns zeros rather than the
 * previous result's bytes. One rule remains, and it is a consequence of the
 * buffer being shared rather than yours:
 *
 * **Neither side may keep it.** Under the default `"ring"` reclamation the slab
 * is refilled after `SharedBytesRingSlabs` (64) further results on the lane, so
 * the worker must not hold the view past the return and the host must copy
 * anything it keeps beyond the next ~64 results. Pools built with
 * `unsafe: { SharedBytesReclaim: "gc" }` instead wait for the host's view to be
 * collected, which removes the rule at a large and load-dependent cost.
 *
 * Calling this is an optimisation, not a requirement: an ordinary `Uint8Array`
 * return over the slab threshold is copied into a slab anyway. `sharedBytes`
 * only saves that copy, by having you build the result in the slab to begin
 * with.
 *
 * Returns under the slab threshold, or made when the pool is out of budget, get
 * an ordinary `Uint8Array` and travel the copy path, so correctness never
 * depends on a slab being available.
 */
export const sharedBytes = (byteLength: number): Uint8Array => {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError("sharedBytes(byteLength) requires a non-negative integer");
  }
  return pool?.allocate(byteLength) ?? new Uint8Array(byteLength);
};

