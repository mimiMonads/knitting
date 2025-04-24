import { fixedPoint } from "../main.ts";
import { setTimeout as sleep } from "node:timers/promises";

const string = "uwu";
export const aaa = fixedPoint({
  args: "void",
  return: "string",
  f: async () => {
    let a = 1000;

    while (a != 0) {
      performance.now();
      a--;
    }
    return string;
  },
});

export const inLine = fixedPoint({

  //@ts-ignore
  f: async (args: Uint8Array) => {
    const argsToString = args.toString();

    const start = Date.now().toString();
    let a = 10000000;

    while (a !== 0) {
      Date.now();
      a--;
    }

    const end = Date.now().toString();

    return argsToString + "+" + start + "+" + end;
  },
});



export const ccc = fixedPoint({
  args: "uint8",
  return: "uint8",
  f: async (arr) => new Uint8Array([3]),
});
