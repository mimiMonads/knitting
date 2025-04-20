import { assertEquals } from "jsr:@std/assert";
import { createThreadPool, fixedPoint } from "../main.ts";

export const toNumber = fixedPoint<number, number>({
  f: async (a) => a,
});

export const toString = fixedPoint<string, string>({
  f: async (a) => a,
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
  f: async (a) => a,
});

Deno.test("Using core  fastcalling wit multiple arguments", async () => {
  const { fastCallFunction, terminateAll } = createThreadPool({})({
    toNumber,
    toString,
    toBigInt,
    toBoolean,
    toVoid,
    toObject,
  });

  assertEquals(
    await fastCallFunction.toString("hello"),
    "hello",
  );

  assertEquals(
    await fastCallFunction.toBigInt(-(2n ** 63n - 1n)),
    -(2n ** 63n - 1n),
  );

  assertEquals(
    await fastCallFunction.toBigInt(2n ** 64n - 1n),
    2n ** 64n - 1n,
  );

  assertEquals(
    await fastCallFunction.toBigInt(2n ** 64n - 1n),
    2n ** 64n - 1n,
  );

  assertEquals(
    await fastCallFunction.toBoolean(true),
    true,
  );

  assertEquals(
    await fastCallFunction.toBoolean(false),
    false,
  );

  assertEquals(
    await fastCallFunction.toVoid(),
    undefined,
  );

  assertEquals(
    await fastCallFunction.toNumber(Infinity),
    Infinity,
  );

  assertEquals(
    await fastCallFunction.toNumber(-Infinity),
    -Infinity,
  );

  assertEquals(
    Number.isNaN(await fastCallFunction.toNumber(NaN)),
    true,
  );

  assertEquals(
    await fastCallFunction.toNumber(Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );

  assertEquals(
    await fastCallFunction.toNumber(Number.MIN_SAFE_INTEGER),
    Number.MIN_SAFE_INTEGER,
  );

  assertEquals(
    await fastCallFunction.toNumber(Number.MAX_VALUE),
    Number.MAX_VALUE,
  );

  assertEquals(
    await fastCallFunction.toNumber(Number.MIN_VALUE),
    Number.MIN_VALUE,
  );

  assertEquals(
    await fastCallFunction.toNumber(0),
    0,
  );

  assertEquals(
    await fastCallFunction.toNumber(2.2250738585072014e-308),
    2.2250738585072014e-308,
  );

  assertEquals(
    await fastCallFunction.toObject(null),
    null,
  );


  await terminateAll();
});
