import { fixedPoint } from "../src/taskApi.ts";

export const aaa = fixedPoint({
  args: "uint8",
  f: async (arr: Uint8Array) => {
    // Simulate an expensive operation
    let a = 1000;

    while (a != 0) {
      performance.now();
      a--;
    }
    return arr;
  },
});

export const inLine = fixedPoint({
  args: "uint8",
  //@ts-ignore
  f: async (args: Uint8Array) => {
    const argsToString = args.toString();

    const start = Date.now().toString();
    let a = 100000;

    while (a !== 0) {
      Date.now();
      a--;
    }

    const end = Date.now().toString();

    return argsToString + "+" + start + "+" + end;
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
