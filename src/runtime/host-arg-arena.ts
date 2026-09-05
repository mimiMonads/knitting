import { getSharedReturnAllocator } from "../memory/payloadCodec.ts";

// Host-side counterpart to `sharedBytes`. It uses the shared submit arena when
// the pool has one; otherwise it returns an ordinary allocation.

export type HostArgAllocator = (byteLength: number) => Uint8Array;

/** Create an argument allocator with a plain-allocation fallback. */
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
    return allocate(byteLength, false) ?? new Uint8Array(byteLength);
  };
};
