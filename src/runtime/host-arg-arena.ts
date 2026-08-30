import { getSharedReturnAllocator } from "../memory/payloadCodec.ts";

// Host-side counterpart to `sharedBytes`: build an argument in the submit arena
// so neither side copies it on the way in.
//
// Two things constrain this, and both are structural rather than incidental.
//
// It needs *one* submit arena to build into, and only the shared submit queue
// has one -- with a dispatcher that gives every worker its own lane, the host
// does not know which arena a call will land in until it is dispatched. So this
// resolves to a plain allocation unless the pool is stealing.
//
// And a borrowed argument is recycled after `SHARED_RETURN_BORROW_WINDOW`
// further large arguments on that lane. A return is read by the host the moment
// it arrives; an argument is read by task code that may hold it across an await.
// That is why it is opt-in (`unsafe.SharedArgs`) where borrowed returns are not.

export type HostArgAllocator = (byteLength: number) => Uint8Array;

/**
 * An allocator for arguments in `payload`'s arena, or one that just allocates.
 *
 * Returns a plain-allocation fallback whenever the pool cannot support borrowed
 * arguments, so callers never have to branch on whether it is available.
 */
export const createHostArgAllocator = (
  payload: object | undefined,
): HostArgAllocator => {
  const allocate = payload === undefined
    ? undefined
    : getSharedReturnAllocator(payload);
  if (allocate === undefined) {
    return (byteLength: number) => new Uint8Array(byteLength);
  }
  return (byteLength: number): Uint8Array => {
    if (!Number.isInteger(byteLength) || byteLength < 0) {
      throw new RangeError(
        "sharedArgBytes(byteLength) requires a non-negative integer",
      );
    }
    // Uninitialized, like `sharedBytes`: the caller writes every byte or hands
    // back a subarray of what it wrote.
    return allocate(byteLength, false) ?? new Uint8Array(byteLength);
  };
};
