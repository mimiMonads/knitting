import { getSharedReturnAllocator } from "../memory/payloadCodec.ts";

// `sharedBytes` uses the worker's return-lane arena; outside that context it
// falls back to an ordinary Uint8Array.

let allocate:
  | ((byteLength: number, zeroFill?: boolean) => Uint8Array | undefined)
  | undefined;

/** Point `sharedBytes` at the arena of `payload`, this worker's return lane. */
export const installSharedReturn = (payload: object): void => {
  allocate = getSharedReturnAllocator(payload);
};

export const resetSharedReturn = (): void => {
  allocate = undefined;
};

/**
 * Allocate an uninitialized borrowed return buffer. The caller must write every
 * byte it returns and must not retain the view beyond the borrow window.
 * Ordinary allocation is used when borrowing is unavailable.
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
