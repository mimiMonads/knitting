import { fixedPoint } from "../main.ts";
import { setTimeout as sleep } from "node:timers/promises";

const string = "uwu";
export const aaa = fixedPoint({
  f: async () => {
    let a = 100000;
    let b = 0;
    while (a != 0) {
      b = b++;
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
    let a = 1;

    while (a !== 0) {
      Date.now();
      a--;
    }

    const end = Date.now().toString();

    return argsToString + "+" + start + "+" + end;
  },
});

export const bbb = fixedPoint({
  args: "void",
  return: "void",
  f: async () => {},
});
