import { assertEquals } from "jsr:@std/assert";
import { createPool } from "../knitting.ts";
import {
  toBigInt,
  toBoolean,
  toHelloWorld,
  toNumber,
  toObject,
  toSet,
  toString,
  toVoid,
} from "./fixtures/parameter_tasks.ts";

const setNumb = new Set([1, 2, 3, 4, 5, 6]);

Deno.test("Using one thread calling with multiple arguments", async () => {
  const { call, shutdown, send } = createPool({})({
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
    call.toString("hello"),
    call.toHelloWorld("hello"),
    call.toBigInt(-(2n ** 63n - 1n)),
    call.toBigInt(2n ** 64n - 1n),
    call.toBoolean(true),
    call.toBoolean(false),
    call.toVoid(undefined),
    call.toNumber(Infinity),
    call.toNumber(-Infinity),
    call.toNumber(NaN),
    call.toNumber(Number.MAX_SAFE_INTEGER),
    call.toNumber(Number.MIN_SAFE_INTEGER),
    call.toNumber(Number.MAX_VALUE),
    call.toNumber(Number.MIN_VALUE),
    call.toNumber(0),
    call.toNumber(2.2250738585072014e-308),
    call.toObject(null),
    call.toSet(setNumb),
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

  await shutdown();
});

Deno.test("Using all thread calling with multiple arguments", async () => {
  const { call, shutdown, send } = createPool({
    threads: 2,
  })({
    toNumber,
    toString,
    toBigInt,
    toBoolean,
    toVoid,
    toObject,
  });

  const promises = [
    call.toString("hello"),
    call.toBigInt(-(2n ** 63n - 1n)),
    call.toBigInt(2n ** 64n - 1n),
    call.toBoolean(true),
    call.toBoolean(false),
    call.toVoid(undefined),
    call.toNumber(Infinity),
    call.toNumber(-Infinity),
    call.toNumber(NaN),
    call.toNumber(Number.MAX_SAFE_INTEGER),
    call.toNumber(Number.MIN_SAFE_INTEGER),
    call.toNumber(Number.MAX_VALUE),
    call.toNumber(Number.MIN_VALUE),
    call.toNumber(0),
    call.toNumber(2.2250738585072014e-308),
    call.toObject(null),
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

  await shutdown();
});
