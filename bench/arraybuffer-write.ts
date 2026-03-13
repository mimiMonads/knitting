import {
  bench,
  do_not_optimize,
  group,
  run as mitataRun,
  summary,
} from "mitata";
import { Buffer as NodeBuffer } from "node:buffer";
import { format, print } from "./ulti/json-parse.ts";

const MIN_SIZE = 1024;
const MAX_SIZE = 1024 * 1024;
const SIZES = Array.from(
  { length: Math.log2(MAX_SIZE / MIN_SIZE) + 1 },
  (_, index) => MIN_SIZE << index,
);

const maxF64Length = Math.ceil(MAX_SIZE / Float64Array.BYTES_PER_ELEMENT);
const sourceBuffer = NodeBuffer.allocUnsafe(MAX_SIZE * 2);
const sourceUint8 = new Uint8Array(
  sourceBuffer.buffer,
  sourceBuffer.byteOffset,
  sourceBuffer.byteLength,
);
const sourceF64 = new Float64Array(maxF64Length);

for (let i = 0; i < sourceUint8.length; i++) sourceUint8[i] = i & 0xff;
for (let i = 0; i < sourceF64.length; i++) sourceF64[i] = i + 0.5;

for (const size of SIZES) {
  const f64SliceLength = size >>> 3;

  group(`ArrayBuffer extract (${size} B)`, () => {
    summary(() => {
      bench("Buffer.allocUnsafeSlow + copy -> ArrayBuffer", () => {
        const out = NodeBuffer.allocUnsafeSlow(size);
        sourceBuffer.copy(out, 0, 0, size);
        const buffer = out.buffer;
        do_not_optimize(new Uint8Array(buffer)[size - 1]);
      });

      bench("Uint8Array.slice (copy) -> ArrayBuffer", () => {
        const buffer = sourceUint8.slice(0, size).buffer;
        do_not_optimize(new Uint8Array(buffer)[size - 1]);
      });

      bench("Float64Array.slice (copy) -> ArrayBuffer", () => {
        const buffer = sourceF64.slice(0, f64SliceLength).buffer;
        do_not_optimize(new Uint8Array(buffer)[size - 1]);
      });
    });
  });
}

await mitataRun({
  format,
  print,
});
