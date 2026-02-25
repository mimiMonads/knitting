import assert from "node:assert/strict";
import test from "node:test";
import {
  createBlockedBindingDescriptor,
  createBlockedDynamicImportHook,
  createInjectedStrictCallable,
  createNodeVmDynamicImportOptions,
  verifyNoRequire,
} from "../src/worker/safety/strict-import.ts";

test("createBlockedDynamicImportHook always throws strict import error", () => {
  const hook = createBlockedDynamicImportHook();
  assert.throws(
    () => hook("node:fs"),
    /Dynamic import\(\) is blocked in sandboxed code/,
  );
});

test("createNodeVmDynamicImportOptions returns import hook", () => {
  const options = createNodeVmDynamicImportOptions();
  assert.equal(typeof options.importModuleDynamically, "function");
  assert.throws(
    () => options.importModuleDynamically("node:fs"),
    /Dynamic import\(\) is blocked in sandboxed code/,
  );
});

test("vm script dynamic import is rejected when strict import options are applied", async () => {
  if (typeof (globalThis as { Deno?: unknown }).Deno !== "undefined") {
    return;
  }

  let vmModule:
    | {
      createContext: (sandbox: object, options?: Record<string, unknown>) => object;
      Script: new (code: string, options?: Record<string, unknown>) => {
        runInContext: (context: object) => unknown;
      };
    }
    | undefined;
  try {
    vmModule = await import("node:vm");
  } catch {
    return;
  }
  if (typeof vmModule?.createContext !== "function") return;
  if (typeof vmModule?.Script !== "function") return;

  const options = createNodeVmDynamicImportOptions();
  const context = vmModule.createContext({}, options);
  const script = new vmModule.Script("import('node:fs')", options);

  await assert.rejects(
    Promise.resolve(script.runInContext(context)),
    (error: unknown) =>
      /Dynamic import\(\) is blocked in sandboxed code/.test(String(error)) ||
      String(error).includes("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG"),
  );
});

test("vm script dynamic import uses strict hook error when vm-modules flag is enabled", async () => {
  if (typeof (globalThis as { Deno?: unknown }).Deno !== "undefined") {
    return;
  }
  if (!(globalThis as { process?: { execArgv?: string[] } }).process?.execArgv?.includes(
    "--experimental-vm-modules",
  )) {
    return;
  }

  const vmModule = await import("node:vm");
  const options = createNodeVmDynamicImportOptions();
  const context = vmModule.createContext({}, options);
  const script = new vmModule.Script("import('node:fs')", options);

  await assert.rejects(
    Promise.resolve(script.runInContext(context)),
    /Dynamic import\(\) is blocked in sandboxed code/,
  );
});

test("verifyNoRequire passes when require/module are absent", () => {
  const sandbox = Object.create(null) as object;
  assert.doesNotThrow(() => verifyNoRequire(sandbox));
});

test("verifyNoRequire throws when require exists on sandbox global", () => {
  const sandbox = Object.create(null) as { require: () => unknown };
  sandbox.require = () => ({});
  assert.throws(
    () => verifyNoRequire(sandbox),
    /FATAL: require found on membrane global/,
  );
});

test("verifyNoRequire throws when require exists on prototype chain", () => {
  const proto = { require: () => ({}) };
  const sandbox = Object.create(proto) as object;
  assert.throws(
    () => verifyNoRequire(sandbox),
    /FATAL: require found on prototype chain/,
  );
});

test("verifyNoRequire accepts a strict blocked getter on the root global", () => {
  const sandbox = Object.create(null) as object;
  Object.defineProperty(
    sandbox,
    "require",
    createBlockedBindingDescriptor("require"),
  );
  Object.defineProperty(
    sandbox,
    "module",
    createBlockedBindingDescriptor("module"),
  );
  assert.doesNotThrow(() => verifyNoRequire(sandbox));
});

test("createInjectedStrictCallable blocks require/module during invocation and restores globals", () => {
  const existingRequire = Object.getOwnPropertyDescriptor(globalThis, "require");
  const existingModule = Object.getOwnPropertyDescriptor(globalThis, "module");
  try {
    Object.defineProperty(globalThis, "require", {
      configurable: true,
      writable: true,
      value: () => "require-ok",
    });
    Object.defineProperty(globalThis, "module", {
      configurable: true,
      writable: true,
      value: { createRequire: () => () => "module-ok" },
    });

    const wrapped = createInjectedStrictCallable(function strictProbe() {
      const g = globalThis as unknown as { require?: () => string };
      return g.require?.();
    });

    assert.throws(
      () => wrapped(),
      /require is blocked/,
    );

    const g = globalThis as unknown as { require?: () => string };
    assert.equal(typeof g.require, "function");
    assert.equal(g.require?.(), "require-ok");
  } finally {
    if (existingRequire) {
      Object.defineProperty(globalThis, "require", existingRequire);
    } else {
      Reflect.deleteProperty(globalThis as Record<string, unknown>, "require");
    }
    if (existingModule) {
      Object.defineProperty(globalThis, "module", existingModule);
    } else {
      Reflect.deleteProperty(globalThis as Record<string, unknown>, "module");
    }
  }
});

test("createInjectedStrictCallable preserves original toString output", () => {
  const original = function originalProbe(value: number) {
    return value + 1;
  };
  const wrapped = createInjectedStrictCallable(original);
  assert.equal(
    wrapped.toString(),
    original.toString(),
  );
});
