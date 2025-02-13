import { fixedPoint } from "./fixpoint.ts";

export const aaa = fixedPoint({
  args: "uint8",
  f: async (arr: Uint8Array) => {
    // Simulate an expensive operation

   return arr
  },
});

export const bbb = fixedPoint({
  args: "uint8",
  f: async (arr) => new Uint8Array([2]),
});

export const ccc = fixedPoint({
  args: "uint8",
  f: async (arr) => new Uint8Array([3]),
});
