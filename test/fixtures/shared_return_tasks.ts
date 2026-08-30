import { task } from "../../knitting.ts";
import { sharedBytes } from "../../unsafe.ts";

// packed = stamp << 21 | byteLength.
const BYTES_MASK = (1 << 21) - 1;

/** Builds its return in a borrowed arena region, so nothing is ever copied. */
export const sharedStamped = task<number, Uint8Array>({
  f: (packed) => {
    const out = sharedBytes(packed & BYTES_MASK);
    out.fill(packed >>> 21);
    return out;
  },
});

/**
 * Writes only the first byte of a region it explicitly asked to be zeroed, so
 * the rest must read as zeros rather than as the previous return's bytes.
 */
export const sharedPartialWrite = task<number, Uint8Array>({
  f: (packed) => {
    const out = sharedBytes(packed & BYTES_MASK, true);
    out[0] = packed >>> 21;
    return out;
  },
});

/**
 * Takes a full-size region, writes a prefix, and hands back only that prefix.
 *
 * The uninitialized tail is never sent, which is the alternative to zeroing --
 * and it only works if the encoder recognises a `subarray` of a borrowed region
 * as still borrowed.
 */
export const sharedPrefix = task<number, Uint8Array>({
  f: (packed) => {
    const written = packed & BYTES_MASK;
    const out = sharedBytes(written * 2);
    out.fill(packed >>> 21, 0, written);
    return out.subarray(0, written);
  },
});

/**
 * An ordinary `Uint8Array` return that never touched `sharedBytes`.
 *
 * At or above `SHARED_RETURN_MIN_BYTES` the encoder places it in a borrowed
 * region instead of letting the host copy it out.
 */
export const plainStamped = task<number, Uint8Array>({
  f: (packed) => {
    const out = new Uint8Array(packed & BYTES_MASK);
    out.fill(packed >>> 21);
    return out;
  },
});

/**
 * Reports how an argument arrived: whether it aliases shared memory, how long it
 * is, and its first byte. The aliasing flag is the only way to tell a borrowed
 * argument from a copied one from outside.
 */
export const echoArgShape = task<Uint8Array, [number, number, number]>({
  f: (bytes) => [
    bytes.buffer instanceof SharedArrayBuffer ? 1 : 0,
    bytes.byteLength,
    bytes[0] ?? -1,
  ],
});
