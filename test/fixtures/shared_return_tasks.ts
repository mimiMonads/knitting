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

let lastMovedReturn: Uint8Array | undefined;

/** Lets the host verify that a default return was moved, rather than borrowed. */
export const returnAndKeepBytes = task<number, Uint8Array>({
  f: (packed) => {
    const out = new Uint8Array(packed & BYTES_MASK);
    out.fill(packed >>> 21);
    lastMovedReturn = out;
    return out;
  },
});

export const keptReturnByteLength = task<void, number>({
  f: () => lastMovedReturn?.byteLength ?? -1,
});

let lastMovedArrayBuffer: ArrayBuffer | undefined;

export const returnAndKeepArrayBuffer = task<number, ArrayBuffer>({
  f: (packed) => {
    const out = new ArrayBuffer(packed & BYTES_MASK);
    new Uint8Array(out).fill(packed >>> 21);
    lastMovedArrayBuffer = out;
    return out;
  },
});

export const keptArrayBufferByteLength = task<void, number>({
  f: () => lastMovedArrayBuffer?.byteLength ?? -1,
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

/**
 * A scratch buffer reused across calls, of which only a prefix is returned.
 *
 * A move detaches the whole backing store, so moving this return would take
 * the scratch with it and break every later call. It has to be copied.
 */
const scratch = new Uint8Array(1024 * 1024);

export const returnScratchPrefix = task<number, Uint8Array>({
  f: (packed) => {
    const written = packed & BYTES_MASK;
    scratch.fill(packed >>> 21, 0, written);
    return scratch.subarray(0, written);
  },
});

export const scratchByteLength = task<void, number>({
  f: () => scratch.byteLength,
});

/**
 * WebAssembly memory: a full-size, non-detachable source.
 *
 * It clears the whole-buffer check, so it reaches the move path and is the
 * case where a runtime can report a successful move without having detached
 * anything -- leaving the host's "owned" result aliasing memory this worker
 * still writes.
 */
const wasmMemory = new WebAssembly.Memory({ initial: 4 });

export const returnWasmBytes = task<number, Uint8Array>({
  f: (packed) => {
    const bytes = new Uint8Array(wasmMemory.buffer);
    bytes.fill(packed >>> 21);
    return bytes;
  },
});

/** Stamps byte 0 of that memory, or -1 if it was detached out from under us. */
export const stampWasmByte = task<number, number>({
  f: (stamp) => {
    const bytes = new Uint8Array(wasmMemory.buffer);
    if (bytes.byteLength === 0) return -1;
    bytes[0] = stamp;
    return bytes[0]!;
  },
});
