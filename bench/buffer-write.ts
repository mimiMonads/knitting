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

const sourceBuffer = NodeBuffer.allocUnsafe(MAX_SIZE * 2);
const sourceUint8 = new Uint8Array(
  sourceBuffer.buffer,
  sourceBuffer.byteOffset,
  sourceBuffer.byteLength,
);

for (let i = 0; i < sourceUint8.length; i++) sourceUint8[i] = i & 0xff;

for (const size of SIZES) {
  group(`Buffer extract (${size} B)`, () => {
    summary(() => {
      bench("Buffer.allocUnsafe + copy -> Buffer", () => {
        const out = NodeBuffer.allocUnsafe(size);
        sourceBuffer.copy(out, 0, 0, size);
        do_not_optimize(out[size - 1]);
      });

      bench("Uint8Array.slice (copy) -> Buffer.from(buffer)", () => {
        const bytes = sourceUint8.slice(0, size);
        const out = NodeBuffer.from(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        do_not_optimize(out[size - 1]);
      });

      bench("ArrayBuffer.slice (copy) -> Buffer.from(buffer)", () => {
        const buffer = sourceUint8.buffer.slice(
          sourceUint8.byteOffset,
          sourceUint8.byteOffset + size,
        );
        const out = NodeBuffer.from(buffer);
        do_not_optimize(out[size - 1]);
      });
    });
  });
}

await mitataRun({
  format,
  print,
});
