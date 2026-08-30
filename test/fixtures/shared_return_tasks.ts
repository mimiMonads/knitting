import { task } from "../../knitting.ts";
import { sharedBytes, sharedReturnPoolStats } from "../../unsafe.ts";

// packed = stamp << 21 | byteLength.
const BYTES_MASK = (1 << 21) - 1;

/** Builds its return directly in a pooled slab, so the host never copies it. */
export const sharedStamped = task<number, Uint8Array>({
  f: (packed) => {
    const out = sharedBytes(packed & BYTES_MASK);
    out.fill(packed >>> 21);
    return out;
  },
});

export const sharedPoolStats = task<void, string>({
  f: () => JSON.stringify(sharedReturnPoolStats()),
});

/** Ring depth is 64 by default; a lane must cycle past it to alias a view. */
export const sharedRingDepthProbe = task<number, Uint8Array>({
  f: (packed) => {
    const out = sharedBytes(packed & BYTES_MASK);
    out.fill(packed >>> 21);
    return out;
  },
});

/**
 * Writes only the first byte, leaving the rest of the slab untouched.
 *
 * On a recycled slab those bytes are the previous return's; the allocator
 * zero-fills so they cannot escape.
 */
export const sharedPartialWrite = task<number, Uint8Array>({
  f: (packed) => {
    const out = sharedBytes(packed & BYTES_MASK);
    out[0] = packed >>> 21;
    return out;
  },
});

/**
 * Returns an ordinary `Uint8Array` that never touched `sharedBytes`.
 *
 * Over the slab threshold the encoder copies it into a slab and ships a
 * pointer, so this exercises the upgrade path rather than the direct one.
 */
export const plainStamped = task<number, Uint8Array>({
  f: (packed) => {
    const out = new Uint8Array(packed & BYTES_MASK);
    out.fill(packed >>> 21);
    return out;
  },
});

/** Same as `plainStamped` but under the threshold, so it must stay a copy. */
export const plainSmall = task<number, Uint8Array>({
  f: (packed) => {
    const out = new Uint8Array(packed & BYTES_MASK);
    out.fill(packed >>> 21);
    return out;
  },
});
