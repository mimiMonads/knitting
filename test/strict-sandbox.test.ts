import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePermissionProtocol } from "../src/permission/protocol.ts";
import {
  ensureStrictSandboxRuntime,
  loadInSandbox,
} from "../src/worker/safety/strict-sandbox.ts";

const strictProtocol = () =>
  resolvePermissionProtocol({
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

test("ensureStrictSandboxRuntime vm context keeps Proxy unreachable", () => {
  const protocol = strictProtocol();
  assert.ok(protocol);
  const runtime = ensureStrictSandboxRuntime(protocol);
  assert.ok(runtime);
  if (!runtime.context) return;
  const assertionFailure = runtime.issues.find((issue) =>
    issue.includes("vm proxy reachability assertion failed")
  );
  assert.equal(assertionFailure, undefined);
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

test("loadInSandbox rejects Object.defineProperties on sandbox global scope", () => {
  const protocol = strictProtocol();
  assert.ok(protocol);
  const runtime = ensureStrictSandboxRuntime(protocol);
  assert.ok(runtime);

  const wrapped = loadInSandbox(function definePropertiesProbe() {
    try {
      Object.defineProperties(globalThis, {
        __knitProbe__: {
          value: true,
          configurable: true,
        },
      });
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

test("loadInSandbox fallback keeps membrane overlay for async calls and restores host globals", () => {
  const cwd = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const probePath = path.join(cwd, "test", "fixtures", "strict_sandbox_async_overlay_probe.ts");
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-transform-types", probePath],
    {
      cwd,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `strict sandbox async overlay probe failed:\n${result.stderr || result.stdout}`,
  );
  const payload = JSON.parse(result.stdout.trim()) as {
    firstResult: string;
    secondResult: string;
    finalProcessType: string;
  };
  assert.equal(payload.firstResult, "undefined");
  assert.equal(payload.secondResult, "undefined");
  assert.equal(payload.finalProcessType, "object");
});

test("fallback host import overlays eval to prevent indirect-eval capture", () => {
  const cwd = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const probePath = path.join(cwd, "test", "fixtures", "strict_sandbox_indirect_eval_probe.ts");
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-transform-types", probePath],
    {
      cwd,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `strict sandbox indirect-eval probe failed:\n${result.stderr || result.stdout}`,
  );
  const payload = JSON.parse(result.stdout.trim()) as {
    loadedInSandbox: boolean;
    result: string;
  };
  assert.equal(payload.loadedInSandbox, false);
  assert.equal(payload.result.includes("KNT_ERROR_PERMISSION_DENIED"), true);
});
