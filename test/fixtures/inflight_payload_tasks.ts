import { task } from "../../knitting.ts";

// packed = stamp << 21 | byteLength, so one number carries both and the argument
// itself never reaches the dynamic payload path under test.
const BYTES_MASK = (1 << 21) - 1;

export const stampedBytes = task<number, Uint8Array>({
  f: (packed) => new Uint8Array(packed & BYTES_MASK).fill(packed >>> 21),
});

export const stampedString = task<number, string>({
  f: (packed) =>
    String.fromCharCode(65 + ((packed >>> 21) % 26)).repeat(packed & BYTES_MASK),
});
