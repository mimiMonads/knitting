import { getSharedReturnAllocator } from "../memory/payloadCodec.ts";

// Worker-facing allocator for returns the consumer should not have to copy.
//
// `sharedBytes(n)` hands back a view over a region of this worker's own return
// payload arena -- memory the host already maps. Returning that view ships an
// offset and a length in the task header, so the host reads the bytes where they
// were written. Nothing is pinned, no token is minted, and no release channel is
// needed: the producing encoder releases the region once its borrow window
// closes.
//
// Outside a worker, or before the return lane exists, it degrades to a plain
// `Uint8Array` and the ordinary copy path.

let allocate:
  | ((byteLength: number, zeroFill?: boolean) => Uint8Array | undefined)
  | undefined;

/** Point `sharedBytes` at the arena of `payload`, this worker's return lane. */
export const installSharedReturn = (payload: object): void => {
  allocate = getSharedReturnAllocator(payload);
};

/** Test seam. */
export const resetSharedReturn = (): void => {
  allocate = undefined;
};

/**
 * A `byteLength` buffer to build a return value in, taken from a region the host
 * can read without copying.
 *
 * **The region is uninitialized**, like `Buffer.allocUnsafe`: it still holds
 * whichever of this worker's earlier returns last used it. You own all
 * `byteLength` bytes -- write them, or hand back `out.subarray(0, written)` so
 * the rest is never sent. `sharedBytes(n, true)` zeroes it first, at the cost of
 * a full extra pass over the region; on V8 that pass alone is most of what the
 * feature saves, which is why it is not the default.
 *
 * One more rule, and it is a consequence of the buffer being shared rather than
 * yours:
 *
 * **Neither side may keep it.** The region is released after
 * `SHARED_RETURN_BORROW_WINDOW` further large results on this lane, so the
 * worker must not hold the view past the return and the host must copy anything
 * it keeps beyond that many results.
 *
 * Calling this is an optimisation, not a requirement: an ordinary `Uint8Array`
 * return at or above `SHARED_RETURN_MIN_BYTES` is placed in a borrowed region
 * anyway, and that path copies the whole payload in, so it never carries a
 * previous return's remainder. `sharedBytes` only saves that copy, by having you
 * build the result in the region to begin with.
 *
 * Returns made when every region is taken get an ordinary `Uint8Array` and
 * travel the copy path, so correctness never depends on a region being free.
 */
export const sharedBytes = (
  byteLength: number,
  zeroFill = false,
): Uint8Array => {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError(
      "sharedBytes(byteLength) requires a non-negative integer",
    );
  }
  return allocate?.(byteLength, zeroFill) ?? new Uint8Array(byteLength);
};
