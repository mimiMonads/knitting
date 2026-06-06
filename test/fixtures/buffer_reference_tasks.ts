import { task } from "../../knitting.ts";
import { BufferReference } from "../../unsafe.ts";

export const sumAndIncrement = task<BufferReference, number>({
  f: (ref) => {
    const bytes = ref.toUint8Array();
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
      sum += bytes[i];
      bytes[i] = (bytes[i] + 1) & 0xff;
    }
    return sum;
  },
});

let borrowedView: Uint8Array | undefined;

export const storeBorrowedViewAndReturnLength = task<BufferReference, number>({
  f: (ref) => {
    borrowedView = ref.toUint8Array();
    return borrowedView.byteLength;
  },
});

export const storedBorrowedViewByteLength = task<void, number>({
  f: () => borrowedView?.byteLength ?? -1,
});

export const returnsBuffer = task<number, BufferReference>({
  f: (n) => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 3) & 0xff;
    return new BufferReference(bytes);
  },
});

export const echoBufferPlusOne = task<BufferReference, BufferReference>({
  f: (ref) => {
    const input = ref.toUint8Array();
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = (input[i] + 1) & 0xff;
    return new BufferReference(out);
  },
});
