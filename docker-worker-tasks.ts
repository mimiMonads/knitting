import { isMain } from "./knitting.ts";

export const addOne = (value: number) => value + 1;

export const reportIsMain = () => isMain;

export const runtimeName = () => {
  if ("Bun" in globalThis) return "bun";
  if ("Deno" in globalThis) return "deno";
  return `node:${process.version}`;
};
