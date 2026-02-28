import assert from "node:assert/strict";
import test from "node:test";
const assertEquals: (actual: unknown, expected: unknown) => void =
  (actual, expected) => {
    assert.deepStrictEqual(actual, expected);
  };
import { Envelope, createPool } from "../knitting.ts";
import {
  toBigInt,
  toBoolean,
  toHelloWorld,
  toNumber,
  toObject,
  toString,
  toVoid,
} from "./fixtures/parameter_tasks.ts";
import { echoEnvelope } from "./fixtures/envelope_tasks.ts";

test("Using one thread calling with multiple arguments", async () => {
  const { call, shutdown } = createPool({})({
    toNumber,
    toString,
    toHelloWorld,
    toBigInt,
    toBoolean,
    toVoid,
    toObject,
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
  ];

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

test("Using all thread calling with multiple arguments", async () => {
  const { call, shutdown } = createPool({
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

test("Envelope payload round-trips through worker calls", async () => {
  const pool = createPool({ threads: 1 })({
    echoEnvelope,
  });
  const payload = new Uint8Array([10, 20, 30, 40]).buffer;
  const input = new Envelope({ path: "/hello", status: 200 }, payload);

  try {
    const out = await pool.call.echoEnvelope(input);
    assertEquals(out instanceof Envelope, true);
    assertEquals(out.header, { path: "/hello", status: 200 });
    assertEquals(Array.from(new Uint8Array(out.payload)), [10, 20, 30, 40]);
  } finally {
    await pool.shutdown();
  }
});

test("createPool accepts payload config object", async () => {
  const pool = createPool({
    threads: 1,
    payload: {
      mode: "fixed",
      payloadMaxByteLength: 2 * 1024 * 1024,
      maxPayloadBytes: 256 * 1024,
    },
  })({
    toString,
  });

  try {
    const out = await pool.call.toString("payload-config-ok");
    assertEquals(out, "payload-config-ok");
  } finally {
    await pool.shutdown();
  }
});
