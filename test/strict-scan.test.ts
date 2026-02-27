import assert from "node:assert/strict";
import test from "node:test";
import { scanCode } from "../src/permission/strict-scan.ts";

test("scanCode rejects null/undefined input", () => {
  assert.throws(
    () =>
      scanCode(undefined as unknown as string, {
        depth: 0,
        origin: "preflight",
      }),
    /must not be null or undefined/,
  );
});

test("scanCode allows empty input", () => {
  const result = scanCode("", {
    depth: 0,
    origin: "preflight",
  });
  assert.equal(result.passed, true);
  assert.equal(result.violations.length, 0);
});

test("preflight catches EVAL-01 while runtime skips preflight-only eval markers", () => {
  const preflight = scanCode("eval('hello')", {
    depth: 0,
    origin: "preflight",
  });
  assert.equal(preflight.passed, false);
  assert.equal(
    preflight.violations.some((entry) => entry.pattern === "EVAL-01"),
    true,
  );

  const runtime = scanCode("eval('hello')", {
    depth: 1,
    origin: "eval",
  });
  assert.equal(runtime.passed, true);
  assert.equal(runtime.violations.length, 0);
});

test("runtime catches dangerous ffi usage", () => {
  const runtime = scanCode("process.binding('natives')", {
    depth: 2,
    origin: "eval",
  });
  assert.equal(runtime.passed, false);
  assert.equal(runtime.violations.length > 0, true);
  assert.equal(runtime.violations[0]?.pattern, "FFI-05");
});

test("scanCode reports deterministic line and column metadata", () => {
  const result = scanCode(
    [
      "const ok = 1;",
      "const alsoOk = 2;",
      "process.binding('natives')",
    ].join("\n"),
    {
      depth: 1,
      origin: "eval",
    },
  );
  const ffiViolation = result.violations.find((entry) => entry.pattern === "FFI-05");
  assert.ok(ffiViolation);
  assert.equal(ffiViolation.line, 3);
  assert.equal(ffiViolation.column, 1);
});

test("preflight rejects dynamic import expressions with AST violation markers", () => {
  const result = scanCode(
    [
      "const specifier = String.fromCharCode(110,111,100,101,58,102,115);",
      "import(specifier);",
    ].join("\n"),
    {
      depth: 0,
      origin: "preflight",
    },
  );

  assert.equal(result.passed, false);
  assert.equal(
    result.violations.some((entry) => entry.pattern === "AST-ImportExpression"),
    true,
  );
});

test("preflight rejects obfuscated dynamic import expressions with AST violation markers", () => {
  const result = scanCode(
    "import(String.fromCharCode(110,111,100,101,58,102,115));",
    {
      depth: 0,
      origin: "preflight",
    },
  );

  assert.equal(result.passed, false);
  assert.equal(
    result.violations.some((entry) => entry.pattern === "AST-ImportExpression"),
    true,
  );
});

test("preflight rejects import.meta metadata access", () => {
  const result = scanCode("const path = import.meta.url;", {
    depth: 0,
    origin: "preflight",
  });
  assert.equal(result.passed, false);
  assert.equal(
    result.violations.some((entry) => entry.pattern === "AST-MetaProperty"),
    true,
  );
});

test("preflight rejects import.meta.resolve() metadata probing", () => {
  const result = scanCode("const x = import.meta.resolve('node:fs');", {
    depth: 0,
    origin: "preflight",
  });
  assert.equal(result.passed, false);
  assert.equal(
    result.violations.some((entry) => entry.pattern === "AST-MetaProperty"),
    true,
  );
});

test("preflight rejects require and module.createRequire call paths", () => {
  const requireResult = scanCode("require('node:fs')", {
    depth: 0,
    origin: "preflight",
  });
  assert.equal(requireResult.passed, false);
  assert.equal(
    requireResult.violations.some((entry) => entry.pattern === "AST-CallExpression:require"),
    true,
  );

  const resolveResult = scanCode("require.resolve('node:fs')", {
    depth: 0,
    origin: "preflight",
  });
  assert.equal(resolveResult.passed, false);
  assert.equal(
    resolveResult.violations.some((entry) => entry.pattern === "IMP-03"),
    true,
  );

  const createRequireResult = scanCode(
    "module.createRequire(import.meta.url)('node:fs')",
    {
      depth: 0,
      origin: "preflight",
    },
  );
  assert.equal(createRequireResult.passed, false);
  assert.equal(
    createRequireResult.violations.some((entry) => entry.pattern === "IMP-06"),
    true,
  );
});

test("runtime scan applies AST phase to intercepted eval payloads", () => {
  const runtime = scanCode("import('node:fs')", {
    depth: 2,
    origin: "eval",
  });
  assert.equal(runtime.passed, false);
  assert.equal(
    runtime.violations.some((entry) => entry.pattern === "AST-ImportExpression"),
    true,
  );
});

test("runtime scan catches obfuscated dynamic import payloads via AST", () => {
  const runtime = scanCode(
    "import(String.fromCharCode(110,111,100,101,58,102,115))",
    {
      depth: 2,
      origin: "eval",
    },
  );
  assert.equal(runtime.passed, false);
  assert.equal(
    runtime.violations.some((entry) => entry.pattern === "AST-ImportExpression"),
    true,
  );
});

test("runtime scan catches Function-constructor import payloads via AST", () => {
  const runtime = scanCode("return import('node:fs')", {
    depth: 2,
    origin: "Function",
  });
  assert.equal(runtime.passed, false);
  assert.equal(
    runtime.violations.some((entry) => entry.pattern === "AST-ImportExpression"),
    true,
  );
});

test("AST parse failure is treated as a blocking violation", () => {
  const result = scanCode("function () {", {
    depth: 1,
    origin: "eval",
  });
  assert.equal(result.passed, false);
  assert.equal(
    result.violations.some((entry) => entry.pattern === "AST-PARSE"),
    true,
  );
});

test("legitimate code without import/eval escapes passes strict scan", () => {
  const source = [
    "const a = 1 + 2;",
    "const b = a * 3;",
    "export const total = b;",
  ].join("\n");
  const result = scanCode(source, {
    depth: 0,
    origin: "preflight",
  });
  assert.equal(result.passed, true);
  assert.equal(result.violations.length, 0);
});

test("AST scan accepts a benign ~10KB payload", () => {
  // Keep each declaration block-scoped so parser behavior is stable across TS versions.
  const block = "{ const value = Math.imul(13, 37); }\n";
  const source = block.repeat(350);
  const result = scanCode(source, {
    depth: 1,
    origin: "eval",
  });

  assert.equal(result.passed, true);
  assert.equal(result.violations.length, 0);
});
