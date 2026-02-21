import { task } from "../../knitting.ts";

export const toNumber = task<number, number>({
  f: async (a) => a,
});

export const toString = task<string, string>({
  f: async (a) => a,
});

export const toHelloWorld = task<string, string>({
  f: async (a) => a + " world",
});

export const toBigInt = task<bigint, bigint>({
  f: async (a) => a,
});

export const toBoolean = task<boolean, boolean>({
  f: async (a) => a,
});

export const toVoid = task({
  f: async (a) => a,
});

export const toObject = task({
  f: async (a: object | null) => a,
});
