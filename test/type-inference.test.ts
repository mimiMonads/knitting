import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import test from "./_runner.ts";
import { createPool, task } from "../knitting.ts";
import { callRawFunctionPool } from "./fixtures/raw_function_tasks.ts";
import { pooledSlowHello } from "./fixtures/type_inference_tasks.ts";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true
  : false;

const rootPath = fileURLToPath(new URL("../", import.meta.url));

const formatDiagnostic = (diagnostic: ts.Diagnostic) => {
  const message = ts.flattenDiagnosticMessageText(
    diagnostic.messageText,
    "\n",
  );

  if (!diagnostic.file || diagnostic.start === undefined) {
    return `TS${diagnostic.code}: ${message}`;
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  return `${diagnostic.file.fileName}:${position.line + 1}:${
    position.character + 1
  } TS${diagnostic.code}: ${message}`;
};

const assertTypeScriptFixturePasses = (
  fixturePath: string,
  compilerOptions: Record<string, unknown>,
) => {
  const parsed = ts.parseJsonConfigFileContent(
    {
      compilerOptions: {
        allowImportingTsExtensions: true,
        lib: ["ES2023", "DOM", "WebWorker", "ES2024.SharedMemory"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        target: "ES2023",
        types: ["bun-types", "node"],
        ...compilerOptions,
      },
      files: [fixturePath],
    },
    ts.sys,
    rootPath,
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [
    ...parsed.errors,
    ...ts.getPreEmitDiagnostics(program),
  ].map(formatDiagnostic);

  assert.deepEqual(diagnostics, []);
};

const hello = task({
  f: (name: string) => `hello ${name}`,
});

type HelloCall = ReturnType<typeof hello.createPool>["call"];
type _helloCallArgs = Assert<
  ["world"] extends Parameters<HelloCall> ? true : false
>;
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
type _abortOnlyCallArgs = Assert<
  [] extends Parameters<AbortOnlyCall> ? true : false
>;
type _abortOnlyCallReturn = Assert<
  ReturnType<AbortOnlyCall> extends Promise<string> ? true : false
>;

const rawHello = (name: string) => `hello ${name}`;

const assertRawFunctionPoolTypes = () => {
  const pool = createPool({ threads: 1 })({ rawHello });
  type RawHelloPooledCall = typeof pool.call.rawHello;
  type _rawHelloPooledCallArgs = Assert<
    ["world"] extends Parameters<RawHelloPooledCall> ? true : false
  >;
  type _rawHelloPooledCallReturn = Assert<
    ReturnType<RawHelloPooledCall> extends Promise<string> ? true : false
  >;
  void pool;
};

test("task inference keeps README-style sync and abort-aware signatures", () => {
  void assertRawFunctionPoolTypes;
  assert.equal(hello.f("world"), "hello world");
  assert.equal(
    slowHello.f("world", { hasAborted: () => false }),
    "hello world",
  );
});

test("createPool supports exported bare functions", async () => {
  assert.deepEqual(await callRawFunctionPool(), [5, 42]);
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

test("createPool accepts non-abort tasks when strictNullChecks is disabled", () => {
  assertTypeScriptFixturePasses(
    "test/fixtures/strict_null_checks_off.ts",
    {
      strict: false,
      strictNullChecks: false,
    },
  );
});
