import assert from "node:assert/strict";
import test from "node:test";
import { createPool, task } from "../knitting.ts";
import { pooledSlowHello } from "./fixtures/type_inference_tasks.ts";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true
  : false;

const hello = task({
  f: (name: string) => `hello ${name}`,
});

type HelloCall = ReturnType<typeof hello.createPool>["call"];
type _helloCallArgs = Assert<["world"] extends Parameters<HelloCall> ? true : false>;
type _helloCallReturn = Assert<Equal<Awaited<ReturnType<HelloCall>>, string>>;

const slowHello = task({
  abortSignal: {
    hasAborted: true,
  },
  f: (name: string, signal) =>
    signal.hasAborted() ? "aborted" : `hello ${name}`,
});

type SlowHelloCall = ReturnType<typeof slowHello.createPool>["call"];
type _slowHelloCallArgs = Assert<
  ["world"] extends Parameters<SlowHelloCall> ? true : false
>;
type _slowHelloCallReturn = Assert<
  ReturnType<SlowHelloCall> extends Promise<string> ? true : false
>;

const abortOnly = task({
  abortSignal: true,
  f: () => Promise.resolve("hello"),
});

type AbortOnlyCall = ReturnType<typeof abortOnly.createPool>["call"];
type _abortOnlyCallArgs = Assert<[] extends Parameters<AbortOnlyCall> ? true : false>;
type _abortOnlyCallReturn = Assert<
  ReturnType<AbortOnlyCall> extends Promise<string> ? true : false
>;

test("task inference keeps README-style sync and abort-aware signatures", () => {
  assert.equal(hello.f("world"), "hello world");
  assert.equal(
    slowHello.f("world", { hasAborted: () => false }),
    "hello world",
  );
});

test("createPool preserves abort-aware call signatures", async () => {
  const pool = createPool({ threads: 1 })({ pooledSlowHello });

  type SlowHelloPooledCall = typeof pool.call.pooledSlowHello;
  type _slowHelloPooledCallArgs = Assert<
    ["world"] extends Parameters<SlowHelloPooledCall> ? true : false
  >;
  type _slowHelloPooledCallReturn = Assert<
    ReturnType<SlowHelloPooledCall> extends Promise<string> ? true : false
  >;

  await assert.doesNotReject(async () => {
    assert.equal(await pool.call.pooledSlowHello("world"), "hello world");
  });

  await pool.shutdown();
});
