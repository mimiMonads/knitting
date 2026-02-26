import assert from "node:assert/strict";
import test from "node:test";
import {
  createMembraneGlobal,
  createSafeReflect,
} from "../src/worker/safety/strict-membrane.ts";

test("TMEM-01 membrane exposes allowlisted globals and utility methods", () => {
  const sandbox = createMembraneGlobal({
    allowConsole: true,
    allowCrypto: true,
    allowPerformance: true,
  }) as Record<string, unknown>;

  assert.equal(typeof sandbox.Object, "function");
  assert.equal(typeof sandbox.Array, "function");
  assert.equal(typeof sandbox.Map, "function");
  assert.equal(typeof sandbox.Int8Array, "function");
  assert.equal(typeof sandbox.Uint16Array, "function");
  assert.equal(typeof sandbox.Float32Array, "function");
  assert.equal(typeof sandbox.parseInt, "function");
  assert.equal(typeof sandbox.queueMicrotask, "function");
  assert.equal(typeof sandbox.clearTimeout, "function");
  assert.equal(typeof sandbox.clearInterval, "function");
  assert.equal(typeof sandbox.AbortController, "function");
  assert.equal(typeof sandbox.AbortSignal, "function");
  assert.equal((sandbox.parseInt as (input: string, radix: number) => number)("42", 10), 42);
  assert.equal(typeof sandbox.Math, "object");
  assert.equal((sandbox.Math as { max: (...args: number[]) => number }).max(1, 4, 2), 4);
  assert.equal(typeof sandbox.JSON, "object");
  assert.equal(
    (sandbox.JSON as { stringify: (value: unknown) => string }).stringify({ ok: true }),
    "{\"ok\":true}",
  );
});

test("TMEM-02..TMEM-07 blocked runtime globals are absent", () => {
  const sandbox = createMembraneGlobal() as Record<string, unknown>;

  assert.equal(sandbox.Bun, undefined);
  assert.equal(sandbox.process, undefined);
  assert.equal(sandbox.require, undefined);
  assert.equal(sandbox.WebAssembly, undefined);
  assert.equal(sandbox.fetch, undefined);
  assert.equal(sandbox.Worker, undefined);
  assert.equal(sandbox.WebSocket, undefined);
  assert.equal(sandbox.Proxy, undefined);
});

test("TMEM-08 membrane has self references and TMEM-09 null prototype", () => {
  const sandbox = createMembraneGlobal() as Record<string, unknown>;

  assert.equal(sandbox.globalThis, sandbox);
  assert.equal(sandbox.self, sandbox);
  assert.equal(Object.getPrototypeOf(sandbox), null);
});

test("TMEM-10..TMEM-12 membrane properties are frozen and immutable", () => {
  const sandbox = createMembraneGlobal({
    allowConsole: true,
  }) as Record<string, unknown>;

  assert.equal(Object.isFrozen(sandbox), true);
  assert.equal(Object.isExtensible(sandbox), false);

  assert.throws(() => {
    Object.defineProperty(sandbox, "newProp", {
      value: "x",
      configurable: true,
      writable: true,
    });
  });

  assert.throws(() => {
    Object.defineProperty(sandbox, "Array", {
      value: function noop() {},
      configurable: true,
      writable: true,
    });
  });
});

test("TMEM-14 safe Reflect blocks protected target mutations", () => {
  const sandbox = createMembraneGlobal() as Record<string, unknown>;
  const safeReflect = sandbox.Reflect as typeof Reflect;
  assert.equal(typeof safeReflect.construct, "function");
  assert.equal(typeof safeReflect.setPrototypeOf, "function");
  assert.throws(() => {
    safeReflect.defineProperty(sandbox as unknown as object, "tmem14", {
      value: 1,
      configurable: true,
    });
  }, /KNT_ERROR_PERMISSION_DENIED/);
  assert.throws(() => {
    safeReflect.setPrototypeOf(sandbox as unknown as object, null);
  }, /KNT_ERROR_PERMISSION_DENIED/);
  const mutable: Record<string, unknown> = {};
  assert.equal(
    safeReflect.defineProperty(mutable, "ok", {
      value: true,
      configurable: true,
      writable: true,
    }),
    true,
  );
  assert.equal(mutable.ok, true);
});

test("TMEM-15 safe Reflect.construct can route through secure constructors", () => {
  let secureCalled = 0;
  const SecureFunction = function (_body: string) {
    secureCalled++;
    return function secureFunctionMarker() {
      return "secure";
    };
  } as unknown as Function;

  const safeReflect = createSafeReflect({
    originalFunction: Function,
    secureFunction: SecureFunction,
  });

  const created = safeReflect.construct(Function, ["return 'host'"]) as () => string;
  assert.equal(secureCalled, 1);
  assert.equal(created(), "secure");
});

test("TMEM-16 namespaces and controlled APIs are frozen", () => {
  const sandbox = createMembraneGlobal({
    allowConsole: true,
    allowCrypto: true,
    allowPerformance: true,
  }) as Record<string, unknown>;

  assert.equal(Object.isFrozen(sandbox.Math as object), true);
  assert.equal(Object.isFrozen(sandbox.JSON as object), true);
  assert.equal(Object.isFrozen(sandbox.Reflect as object), true);
  if (sandbox.console) {
    assert.equal(Object.isFrozen(sandbox.console as object), true);
  }
  if (sandbox.crypto) {
    assert.equal(Object.isFrozen(sandbox.crypto as object), true);
  }
  if (sandbox.performance) {
    assert.equal(Object.isFrozen(sandbox.performance as object), true);
  }
});

test("TMEM-17 membrane hides non-allowlisted host globals by default", () => {
  const sandbox = createMembraneGlobal({
    allowConsole: true,
    allowCrypto: true,
    allowPerformance: true,
  }) as Record<string, unknown>;
  const membraneKeys = new Set(Reflect.ownKeys(sandbox).map((key) => String(key)));
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (membraneKeys.has(key)) continue;
    assert.equal(
      sandbox[key],
      undefined,
      `expected ${key} to be undefined on membrane`,
    );
  }
});

test("TMEM-18 membrane Object.defineProperty/defineProperties reject global scope writes", () => {
  const sandbox = createMembraneGlobal() as Record<string, unknown>;
  const safeObject = sandbox.Object as ObjectConstructor;

  assert.throws(() => {
    safeObject.defineProperty(sandbox as unknown as object, "tmem18", {
      value: 1,
      configurable: true,
    });
  }, /KNT_ERROR_PERMISSION_DENIED/);
  assert.throws(() => {
    safeObject.defineProperties(sandbox as unknown as object, {
      tmem18: {
        value: 1,
        configurable: true,
      },
    });
  }, /KNT_ERROR_PERMISSION_DENIED/);

  const local: Record<string, unknown> = {};
  safeObject.defineProperty(local, "x", {
    value: 1,
    configurable: true,
    writable: true,
  });
  safeObject.defineProperties(local, {
    y: {
      value: 2,
      configurable: true,
      writable: true,
    },
  });
  assert.equal(local.x, 1);
  assert.equal(local.y, 2);
});

test("CFG-10 additional globals reject runtime-native API names", () => {
  assert.throws(
    () => createMembraneGlobal({ additionalGlobals: { process: {} } }),
    /runtime-native API/,
  );
  assert.throws(
    () => createMembraneGlobal({ additionalGlobals: { "Bun.ffi": {} } }),
    /runtime-native API/,
  );
});

test("CFG-11 additional globals are frozen and CFG-12 wrappers are applied", () => {
  const sandbox = createMembraneGlobal({
    additionalGlobals: {
      shared: {
        nested: {
          value: "abc",
        },
      },
      title: "knitting",
    },
    customWrappers: {
      title: (value) => String(value).toUpperCase(),
    },
  }) as Record<string, unknown>;

  assert.equal(sandbox.title, "KNITTING");
  const shared = sandbox.shared as {
    nested: {
      value: string;
    };
  };
  assert.equal(Object.isFrozen(shared), true);
  assert.equal(Object.isFrozen(shared.nested), true);
  assert.throws(() => {
    Object.defineProperty(shared.nested, "value", {
      value: "x",
      configurable: true,
      writable: true,
    });
  });
});
