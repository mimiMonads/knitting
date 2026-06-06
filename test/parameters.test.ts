import assert from "node:assert/strict";
import test from "./_runner.ts";
const assertEquals: (actual: unknown, expected: unknown) => void = (
  actual,
  expected,
) => {
  assert.deepStrictEqual(actual, expected);
};
import { createPool, Envelope } from "../knitting.ts";
import {
  toBigInt,
  toBoolean,
  toHelloWorld,
  toNumber,
  toObject,
  toString,
  toVoid,
} from "./fixtures/parameter_tasks.ts";
import {
  bumpEnvelopeShared,
  echoEnvelope,
  invertEnvelope,
} from "./fixtures/envelope_tasks.ts";
import { BufferReference } from "../unsafe.ts";

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

test("Envelope with SharedArrayBuffer body round-trips zero-copy through a thread worker", async () => {
  if (typeof SharedArrayBuffer !== "function") return;
  const pool = createPool({ threads: 1 })({ bumpEnvelopeShared });
  const sab = new SharedArrayBuffer(8);
  new Uint8Array(sab).set([5, 0, 0, 0, 0, 0, 0, 0]);
  const input = new Envelope({ tag: "img" }, sab);

  try {
    const out = await pool.call.bumpEnvelopeShared(input);
    assertEquals(out instanceof Envelope, true);
    assertEquals(out.header, { tag: "img:seen" });
    assertEquals(new Uint8Array(sab)[0], 6);
    assertEquals(new Uint8Array(out.payload)[0], 6);
  } finally {
    await pool.shutdown();
  }
});

test("Envelope with BufferReference body round-trips through a thread worker", async () => {
  try {
    new BufferReference(new Uint8Array([0])).release();
  } catch {
    return;
  }

  const pool = createPool({ threads: 1 })({ invertEnvelope });
  const input = new Envelope(
    { op: "invert" },
    new BufferReference(new Uint8Array([0, 64, 128, 255])),
  );

  try {
    const out = await pool.call.invertEnvelope(input);
    assertEquals(out instanceof Envelope, true);
    assertEquals(out.header, { op: "invert:done" });
    assertEquals(Array.from(out.payload.toUint8Array()), [255, 191, 127, 0]);
    out.payload.release();
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
