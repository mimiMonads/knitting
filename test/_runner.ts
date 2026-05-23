import type nodeTest from "node:test";

type TestFunction = typeof nodeTest;

const runtimeProcess = (globalThis as typeof globalThis & {
  process?: { versions?: { bun?: string } };
}).process;
const testModuleSpecifier = runtimeProcess?.versions?.bun
  ? "bun:test"
  : "node:test";
const testModule = await import(testModuleSpecifier) as {
  default?: unknown;
  test?: unknown;
};
const selectedTest = typeof testModule.default === "function"
  ? testModule.default
  : testModule.test;

if (typeof selectedTest !== "function") {
  throw new Error(`Could not load test function from ${testModuleSpecifier}`);
}

const test: TestFunction = selectedTest as TestFunction;

export default test;
