import { assertEquals } from "jsr:@std/assert";
import { createThreadPool, fixedPoint } from "../knitting.ts";
import { cpus } from "node:os";

export const toNumber = fixedPoint<number, number>({
  f: async (a) => a,
});

export const toString = fixedPoint<string, string>({
  f: async (a) => a,
});

export const toHelloWorld = fixedPoint<string, string>({
  f: async (a) => a + " world",
});

export const toBigInt = fixedPoint<bigint, bigint>({
  f: async (a) => a,
});

export const toBoolean = fixedPoint<boolean, boolean>({
  f: async (a) => a,
});

export const toVoid = fixedPoint({
  f: async (a) => a,
});

export const toObject = fixedPoint({
  f: async (a: object | null) => a,
});

export const toSet = fixedPoint({
  f: async (a: Set<number>) => a,
});

const setNumb = new Set([1, 2, 3, 4, 5, 6]);

Deno.test("Using one thread calling with multiple arguments", async () => {
  const { callFunction, terminateAll, send } = createThreadPool({})({
    toNumber,
    toString,
    toHelloWorld,
    toBigInt,
    toBoolean,
    toVoid,
    toObject,
    toSet,
  });

  const promises = [
    callFunction.toString("hello"),
    callFunction.toHelloWorld("hello"),
    callFunction.toBigInt(-(2n ** 63n - 1n)),
    callFunction.toBigInt(2n ** 64n - 1n),
    callFunction.toBoolean(true),
    callFunction.toBoolean(false),
    callFunction.toVoid(undefined),
    callFunction.toNumber(Infinity),
    callFunction.toNumber(-Infinity),
    callFunction.toNumber(NaN),
    callFunction.toNumber(Number.MAX_SAFE_INTEGER),
    callFunction.toNumber(Number.MIN_SAFE_INTEGER),
    callFunction.toNumber(Number.MAX_VALUE),
    callFunction.toNumber(Number.MIN_VALUE),
    callFunction.toNumber(0),
    callFunction.toNumber(2.2250738585072014e-308),
    callFunction.toObject(null),
    callFunction.toSet(setNumb),
  ];

  send();

  const results = await Promise.all(promises);

  const expected = [
    "hello",
    "hello world",
    -(2n ** 63n - 1n),
    2n ** 64n - 1n,
    true,
    false,
    undefined,
    Infinity,
    -Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    0,
    2.2250738585072014e-308,
    null,
    setNumb,
  ];

  results.forEach((value, index) => {
    if (typeof value === "number" && Number.isNaN(value)) {
      assertEquals(Number.isNaN(expected[index]), true);
    } else {
      assertEquals(value, expected[index]);
    }
  });

  await terminateAll();
});

Deno.test("Using all thread calling with multiple arguments", async () => {
  const { callFunction, terminateAll, send } = createThreadPool({
    threads: cpus().length / 4,
  })({
    toNumber,
    toString,
    toBigInt,
    toBoolean,
    toVoid,
    toObject,
  });

  const promises = [
    callFunction.toString("hello"),
    callFunction.toBigInt(-(2n ** 63n - 1n)),
    callFunction.toBigInt(2n ** 64n - 1n),
    callFunction.toBoolean(true),
    callFunction.toBoolean(false),
    callFunction.toVoid(undefined),
    callFunction.toNumber(Infinity),
    callFunction.toNumber(-Infinity),
    callFunction.toNumber(NaN),
    callFunction.toNumber(Number.MAX_SAFE_INTEGER),
    callFunction.toNumber(Number.MIN_SAFE_INTEGER),
    callFunction.toNumber(Number.MAX_VALUE),
    callFunction.toNumber(Number.MIN_VALUE),
    callFunction.toNumber(0),
    callFunction.toNumber(2.2250738585072014e-308),
    callFunction.toObject(null),
  ];

  send();

  const results = await Promise.all(promises);

  const expected = [
    "hello",
    -(2n ** 63n - 1n),
    2n ** 64n - 1n,
    true,
    false,
    undefined,
    Infinity,
    -Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    0,
    2.2250738585072014e-308,
    null,
  ];

  results.forEach((value, index) => {
    if (typeof value === "number" && Number.isNaN(value)) {
      assertEquals(Number.isNaN(expected[index]), true);
    } else {
      assertEquals(value, expected[index]);
    }
  });

  await terminateAll();
});
