import type nodeTest from "node:test";

type TestFunction = typeof nodeTest;

type TestOptions = {
  skip?: boolean | string;
  todo?: boolean | string;
  timeout?: number;
};

type AnyTest = (
  name: string,
  optionsOrFn?: unknown,
  maybeFn?: unknown,
) => unknown;

const runtimeProcess = (globalThis as typeof globalThis & {
  process?: { versions?: { bun?: string } };
}).process;
const isBun = runtimeProcess?.versions?.bun !== undefined;
const testModuleSpecifier = isBun ? "bun:test" : "node:test";
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

const baseTest = selectedTest as AnyTest & {
  skip: AnyTest;
  only: AnyTest;
  todo: AnyTest;
};

/**
 * bun:test takes its options as a third argument, so node's
 * `(name, options, fn)` overload silently drops them: skipped tests run and
 * per-test timeouts fall back to bun's 5s default. Translate the node shape
 * into bun's so every suite can keep writing one signature.
 */
const adaptToBun = (variant: AnyTest): AnyTest =>
(
  name: string,
  optionsOrFn?: unknown,
  maybeFn?: unknown,
) => {
  if (typeof optionsOrFn !== "object" || optionsOrFn === null) {
    return variant(name, optionsOrFn, maybeFn);
  }

  const { skip, todo, timeout } = optionsOrFn as TestOptions;
  // bun has no place to print a skip reason, so it rides along in the name.
  const reason = typeof skip === "string"
    ? skip
    : typeof todo === "string"
    ? todo
    : undefined;
  const label = reason === undefined ? name : `${name} [${reason}]`;
  const runner = skip ? baseTest.skip : todo ? baseTest.todo : variant;
  return runner(
    label,
    maybeFn,
    timeout === undefined ? undefined : { timeout },
  );
};

// bun exposes these as getters, and reading `only` throws outright under CI.
// Forward them lazily so a variant is touched only when a suite asks for it.
const withVariants = (adapted: AnyTest): AnyTest => {
  for (const variant of ["skip", "only", "todo"] as const) {
    Object.defineProperty(adapted, variant, {
      configurable: true,
      get: () => adaptToBun(baseTest[variant]),
    });
  }
  return adapted;
};

const test: TestFunction = (isBun
  ? withVariants(adaptToBun(baseTest))
  : baseTest) as TestFunction;

export default test;
