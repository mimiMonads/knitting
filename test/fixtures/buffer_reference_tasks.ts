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
