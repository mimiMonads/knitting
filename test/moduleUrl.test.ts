import assert from "node:assert/strict";
import test from "node:test";
const assertEquals: (actual: unknown, expected: unknown) => void =
  (actual, expected) => {
    assert.deepStrictEqual(actual, expected);
  };
import { toModuleUrl } from "../src/common/module-url.ts";

test("toModuleUrl keeps URL specifiers stable", () => {
  assertEquals(
    toModuleUrl("file:///C:/repo/knitting/test/runtime.node.test.ts"),
    "file:///C:/repo/knitting/test/runtime.node.test.ts",
  );
  assertEquals(
    toModuleUrl("https://example.com/x.ts"),
    "https://example.com/x.ts",
  );
});

test("toModuleUrl converts windows drive paths to file URL", () => {
  assertEquals(
    toModuleUrl("C:\\repo\\knitting\\test\\runtime node.test.ts"),
    "file:///C:/repo/knitting/test/runtime%20node.test.ts",
  );
});

test("toModuleUrl converts windows UNC paths to file URL", () => {
  assertEquals(
    toModuleUrl("\\\\server\\share\\repo\\task.ts"),
    "file://server/share/repo/task.ts",
  );
});

test("toModuleUrl converts local paths to file URL", () => {
  const result = toModuleUrl("./test/fixtures/hello_world.ts");
  assertEquals(result.startsWith("file://"), true);
  assertEquals(result.endsWith("/test/fixtures/hello_world.ts"), true);
});
