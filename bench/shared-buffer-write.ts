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

const sourceBacking = new ArrayBuffer(MAX_SIZE);
const sourceUint8Full = new Uint8Array(sourceBacking);
for (let i = 0; i < sourceUint8Full.length; i++) sourceUint8Full[i] = i & 0xff;

const sourceBufferFull = NodeBuffer.from(
  sourceBacking,
  sourceUint8Full.byteOffset,
  sourceUint8Full.byteLength,
);
const sourceFloat64Full = new Float64Array(
  sourceBacking,
  sourceUint8Full.byteOffset,
  sourceUint8Full.byteLength >>> 3,
);

const targetUint8Full = new Uint8Array(new SharedArrayBuffer(MAX_SIZE));
const targetBufferSetFull = NodeBuffer.from(new SharedArrayBuffer(MAX_SIZE));
const targetBufferCopyFull = NodeBuffer.from(new SharedArrayBuffer(MAX_SIZE));
const targetFloat64Full = new Float64Array(
  new SharedArrayBuffer(MAX_SIZE),
  0,
  MAX_SIZE >>> 3,
);

for (const size of SIZES) {
  const float64Length = size >>> 3;

  const sourceUint8 = sourceUint8Full.subarray(0, size);
  const sourceBuffer = sourceBufferFull.subarray(0, size);
  const sourceFloat64 = sourceFloat64Full.subarray(0, float64Length);

  const targetUint8 = targetUint8Full.subarray(0, size);
  const targetBufferSet = targetBufferSetFull.subarray(0, size);
  const targetBufferCopy = targetBufferCopyFull.subarray(0, size);
  const targetFloat64 = targetFloat64Full.subarray(0, float64Length);

  group(`SharedArrayBuffer write (${size} B)`, () => {
    summary(() => {
      bench("Uint8Array.set(srcU8) -> SAB Uint8Array view", () => {
        targetUint8.set(sourceUint8);
        do_not_optimize(targetUint8[size - 1]);
      });

      bench("Buffer.set(srcU8) -> SAB Buffer view", () => {
        targetBufferSet.set(sourceUint8);
        do_not_optimize(targetBufferSet[size - 1]);
      });

      bench("Buffer.copy(cached srcBuf) -> SAB Buffer view", () => {
        sourceBuffer.copy(targetBufferCopy, 0, 0, size);
        do_not_optimize(targetBufferCopy[size - 1]);
      });

      bench("Buffer.from(srcU8).copy -> SAB Buffer view", () => {
        const sourceBufferView = NodeBuffer.from(
          sourceUint8.buffer,
          sourceUint8.byteOffset,
          sourceUint8.byteLength,
        );
        sourceBufferView.copy(targetBufferCopy, 0, 0, size);
        do_not_optimize(targetBufferCopy[size - 1]);
      });

      bench("Float64Array.set(cached srcF64) -> SAB Float64Array view", () => {
        targetFloat64.set(sourceFloat64);
        do_not_optimize(targetFloat64[float64Length - 1]);
      });

      bench("new Float64Array(srcU8).set -> SAB Float64Array view", () => {
        const sourceFloat64View = new Float64Array(
          sourceUint8.buffer,
          sourceUint8.byteOffset,
          float64Length,
        );
        targetFloat64.set(sourceFloat64View);
        do_not_optimize(targetFloat64[float64Length - 1]);
      });
    });
  });
}

await mitataRun({
  format,
  print,
});
