import { assertEquals } from "jsr:@std/assert";
import { toModuleUrl } from "../src/common/module-url.ts";

Deno.test("toModuleUrl keeps URL specifiers stable", () => {
  assertEquals(
    toModuleUrl("file:///C:/repo/knitting/test/runtime.node.test.ts"),
    "file:///C:/repo/knitting/test/runtime.node.test.ts",
  );
  assertEquals(
    toModuleUrl("https://example.com/x.ts"),
    "https://example.com/x.ts",
  );
});

Deno.test("toModuleUrl converts windows drive paths to file URL", () => {
  assertEquals(
    toModuleUrl("C:\\repo\\knitting\\test\\runtime node.test.ts"),
    "file:///C:/repo/knitting/test/runtime%20node.test.ts",
  );
});

Deno.test("toModuleUrl converts windows UNC paths to file URL", () => {
  assertEquals(
    toModuleUrl("\\\\server\\share\\repo\\task.ts"),
    "file://server/share/repo/task.ts",
  );
});

Deno.test("toModuleUrl converts local paths to file URL", () => {
  const result = toModuleUrl("./test/fixtures/hello_world.ts");
  assertEquals(result.startsWith("file://"), true);
  assertEquals(result.endsWith("/test/fixtures/hello_world.ts"), true);
});
