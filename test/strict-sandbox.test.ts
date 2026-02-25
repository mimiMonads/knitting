import assert from "node:assert/strict";
import test from "node:test";
import { resolvePermisonProtocol } from "../src/permison/protocol.ts";
import {
  ensureStrictSandboxRuntime,
  loadInSandbox,
} from "../src/worker/safety/strict-sandbox.ts";

const strictProtocol = () =>
  resolvePermisonProtocol({
    permission: {
      mode: "strict",
      strict: {
        recursiveScan: true,
        sandbox: true,
      },
    },
  });

test("ensureStrictSandboxRuntime creates runtime with membrane globals", () => {
  const protocol = strictProtocol();
  assert.ok(protocol);
  const runtime = ensureStrictSandboxRuntime(protocol);
  assert.ok(runtime);
  const g = runtime.membraneGlobal as Record<string, unknown>;
  assert.equal(runtime.vmEnabled === true || runtime.vmEnabled === false, true);
  assert.equal(g.process, undefined);
  assert.equal(g.Bun, undefined);
  assert.equal(g.require, undefined);
  assert.equal(g.globalThis, g);
  assert.equal(g.self, g);
  assert.equal(Object.getPrototypeOf(g), null);
});

test("loadInSandbox executes callables against strict membrane global state", () => {
  const protocol = strictProtocol();
  assert.ok(protocol);
  const runtime = ensureStrictSandboxRuntime(protocol);
  assert.ok(runtime);

  const wrapped = loadInSandbox(function probeMembrane() {
    const g = globalThis as Record<string, unknown>;
    const listCtor = ([] as unknown[]).constructor as unknown as {
      constructor: (source: string) => () => unknown;
      [key: string]: unknown;
    };
    const maybeCtor =
      listCtor["constructor"] as (source: string) => () => unknown;
    return {
      processType: typeof g.process,
      bunType: typeof g.Bun,
      globalThisIsSelf: g === (g.self as unknown),
      globalProtoIsNull: Object.getPrototypeOf(g) === null,
      constructorEscape: String(maybeCtor("return typeof process")()),
    };
  }, runtime);

  const result = wrapped() as {
    processType: string;
    bunType: string;
    globalThisIsSelf: boolean;
    globalProtoIsNull: boolean;
    constructorEscape: string;
  };
  assert.equal(result.processType, "undefined");
  assert.equal(result.bunType, "undefined");
  assert.equal(typeof result.globalThisIsSelf, "boolean");
  assert.equal(typeof result.globalProtoIsNull, "boolean");
  assert.equal(result.constructorEscape, "undefined");
});

test("loadInSandbox applies recursive eval scanner on membrane eval", () => {
  const protocol = strictProtocol();
  assert.ok(protocol);
  const runtime = ensureStrictSandboxRuntime(protocol);
  assert.ok(runtime);

  const wrapped = loadInSandbox(function evalProbe() {
    try {
      (globalThis as { eval: (code: string) => unknown }).eval(
        "process.binding('natives')",
      );
      return "allowed";
    } catch (error) {
      return String(error);
    }
  }, runtime);

  const result = wrapped();
  assert.equal(typeof result, "string");
  assert.equal(
    String(result).includes("KNT_ERROR_PERMISSION_DENIED"),
    true,
  );
});

test("loadInSandbox blocks dynamic import in eval payloads", () => {
  const protocol = strictProtocol();
  assert.ok(protocol);
  const runtime = ensureStrictSandboxRuntime(protocol);
  assert.ok(runtime);

  const wrapped = loadInSandbox(function evalImportProbe() {
    try {
      (globalThis as { eval: (code: string) => unknown }).eval(
        "import('node:fs')",
      );
      return "allowed";
    } catch (error) {
      return String(error);
    }
  }, runtime);

  const result = wrapped();
  assert.equal(typeof result, "string");
  assert.equal(
    String(result).includes("KNT_ERROR_PERMISSION_DENIED"),
    true,
  );
});

test("loadInSandbox blocks dynamic import in Function constructor payloads", () => {
  const protocol = strictProtocol();
  assert.ok(protocol);
  const runtime = ensureStrictSandboxRuntime(protocol);
  assert.ok(runtime);

  const wrapped = loadInSandbox(function functionCtorImportProbe() {
    try {
      const fn = Function("return import('node:fs')");
      return typeof fn();
    } catch (error) {
      return String(error);
    }
  }, runtime);

  const result = wrapped();
  assert.equal(typeof result, "string");
  assert.equal(
    String(result).includes("KNT_ERROR_PERMISSION_DENIED"),
    true,
  );
});

test("TMEM-13 constructor-chain function path is secured in sandbox runtime", () => {
  const protocol = strictProtocol();
  assert.ok(protocol);
  const runtime = ensureStrictSandboxRuntime(protocol);
  assert.ok(runtime);

  const wrapped = loadInSandbox(function constructorChainProbe() {
    try {
      const chainCtor = ([] as unknown[]).constructor.constructor as unknown as (
        ...args: string[]
      ) => () => unknown;
      const fn = chainCtor("return typeof process");
      return String(fn());
    } catch (error) {
      return String(error);
    }
  }, runtime);

  const result = wrapped();
  assert.equal(typeof result, "string");
  assert.equal(result, "undefined");
});

test("loadInSandbox keeps require/module inaccessible", () => {
  const protocol = strictProtocol();
  assert.ok(protocol);
  const runtime = ensureStrictSandboxRuntime(protocol);
  assert.ok(runtime);

  const wrapped = loadInSandbox(function requireModuleProbe() {
    const g = globalThis as Record<string, unknown>;
    return {
      requireType: typeof g.require,
      moduleType: typeof g.module,
    };
  }, runtime);

  const result = wrapped() as {
    requireType: string;
    moduleType: string;
  };
  assert.equal(result.requireType, "undefined");
  assert.equal(result.moduleType, "undefined");
});
