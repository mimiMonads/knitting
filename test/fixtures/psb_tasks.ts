import { task } from "../../knitting.ts";
import type { ProcessSharedBuffer } from "../../src/connections/index.ts";

export const readInt32AtZero = task<ProcessSharedBuffer, number>({
  f: (buffer) => Atomics.load(buffer.view(Int32Array), 0),
});

export const writeSevenAndReadInt32 = task<ProcessSharedBuffer, number>({
  f: (buffer) => {
    const view = buffer.view(Int32Array);
    Atomics.store(view, 0, 7);
    return Atomics.load(view, 0);
  },
});
