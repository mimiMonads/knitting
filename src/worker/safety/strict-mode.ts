import type { ResolvedPermissionProtocol } from "../../permission/protocol.ts";
import {
  StrictModeDepthError,
  StrictModeViolationError,
  resolveStrictModeOptions,
  scanCode,
} from "../../permission/strict-scan.ts";
import { RUNTIME } from "../../common/runtime.ts";
import {
  createBlockedBindingDescriptor,
  isBlockedBindingDescriptor,
  verifyNoRequire,
} from "./strict-import.ts";

type GlobalWithStrictRuntimeGuard = typeof globalThis & {
  __knittingStrictRuntimeGuardInstalled?: boolean;
};

const STRICT_SECURE_CONSTRUCTOR = Symbol.for(
  "knitting.strict.secureConstructor",
);

const ignoreError = (action: () => void): void => {
  try {
    action();
  } catch {
  }
};

const tryDefineProperty = (
  defineProperty: ObjectConstructor["defineProperty"],
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor,
): void => {
  ignoreError(() => {
    defineProperty(target, property, descriptor);
  });
};

const markProtectedProperty = (
  state: WeakMap<object, Set<PropertyKey>>,
  target: object,
  property: PropertyKey,
): void => {
  const set = state.get(target) ?? new Set<PropertyKey>();
  set.add(property);
  state.set(target, set);
};

const isProtectedProperty = (
  state: WeakMap<object, Set<PropertyKey>>,
  target: object,
  property: PropertyKey,
): boolean => state.get(target)?.has(property) === true;

const defineLockedProperty = (
  defineProperty: ObjectConstructor["defineProperty"],
  protectedState: WeakMap<object, Set<PropertyKey>>,
  target: object,
  property: PropertyKey,
  value: unknown,
) =>
  defineLockedDescriptor(defineProperty, protectedState, target, property, {
    value,
    writable: false,
    enumerable: true,
  });

const defineLockedDescriptor = (
  defineProperty: ObjectConstructor["defineProperty"],
  protectedState: WeakMap<object, Set<PropertyKey>>,
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor,
) => {
  defineProperty(target, property, {
    ...descriptor,
    configurable: false,
    enumerable: descriptor.enumerable ?? false,
  });
  markProtectedProperty(protectedState, target, property);
};

const shouldInstallStrictRuntimeGuard = (
  protocol?: ResolvedPermissionProtocol,
): boolean =>
  protocol?.enabled === true &&
  protocol.unsafe !== true &&
  protocol.mode === "strict";

export const installStrictModeRuntimeGuard = (
  protocol?: ResolvedPermissionProtocol,
): void => {
  if (!shouldInstallStrictRuntimeGuard(protocol)) return;
  const strictOptions = resolveStrictModeOptions(protocol?.strict);
  if (strictOptions.recursiveScan === false) return;

  const g = globalThis as GlobalWithStrictRuntimeGuard;
  if (g.__knittingStrictRuntimeGuardInstalled === true) return;
  try {
    const maxEvalDepth = strictOptions.maxEvalDepth;
    const protectedState = new WeakMap<object, Set<PropertyKey>>();
    const originalDefineProperty = Object.defineProperty;
    const originalDefineProperties = Object.defineProperties;
    let evalDepth = 0;
    const lockValue = (target: object, property: PropertyKey, value: unknown): void => {
      defineLockedProperty(
        originalDefineProperty,
        protectedState,
        target,
        property,
        value,
      );
    };
    const withScannedExecution = <T>(
      origin: string,
      source: string,
      run: () => T,
    ): T => {
      const nextDepth = enter(origin);
      runScan(source, origin, nextDepth);
      evalDepth++;
      try {
        return run();
      } finally {
        evalDepth--;
      }
    };

    if (RUNTIME === "bun") {
      for (const binding of ["require", "module"] as const) {
        const existing = Object.getOwnPropertyDescriptor(globalThis as object, binding);
        if (
          existing?.configurable === false &&
          isBlockedBindingDescriptor(existing) !== true
        ) {
          throw new Error(
            `KNT_ERROR_PERMISSION_DENIED: strict mode cannot lock global ${binding}`,
          );
        }
        defineLockedDescriptor(
          originalDefineProperty,
          protectedState,
          globalThis as object,
          binding,
          createBlockedBindingDescriptor(binding),
        );
      }

      verifyNoRequire(globalThis as object);
    }

    const runScan = (code: string, origin: string, depth: number): void => {
      const source = `${origin}@depth-${depth}`;
      const result = scanCode(code, { depth, origin, source }, strictOptions);
      if (result.passed === true) return;
      throw new StrictModeViolationError({
        origin,
        depth,
        source,
        violations: result.violations,
        scannedCode: code,
      });
    };

    const enter = (origin: string): number => {
      const nextDepth = evalDepth + 1;
      if (nextDepth >= maxEvalDepth) {
        throw new StrictModeDepthError({
          currentDepth: nextDepth,
          maxDepth: maxEvalDepth,
          origin,
        });
      }
      return nextDepth;
    };

    const wrapConstructor = (
      originalCtor: Function,
      origin: string,
    ): Function => {
      if (
        (originalCtor as unknown as Record<symbol, unknown>)[
          STRICT_SECURE_CONSTRUCTOR
        ] === true
      ) {
        return originalCtor;
      }
      const secure = function (this: unknown, ...args: unknown[]) {
        return withScannedExecution(
          origin,
          args.map((value) => String(value)).join("\n"),
          () =>
            Reflect.construct(
              originalCtor,
              args,
              new.target ? (new.target as Function) : originalCtor,
            ),
        );
      };

      tryDefineProperty(originalDefineProperty, secure as object, "name", { value: origin });
      tryDefineProperty(
        originalDefineProperty,
        secure as object,
        STRICT_SECURE_CONSTRUCTOR,
        { value: true },
      );
      return secure;
    };

    const originalEval = globalThis.eval;
    const secureEval = function (code: unknown): unknown {
      if (typeof code !== "string") return code;
      return withScannedExecution("eval", code, () =>
        Reflect.apply(
          originalEval as (source: string) => unknown,
          globalThis,
          [code],
        ),
      );
    };

    const OriginalFunction = Function as unknown as Function;
    const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor as Function;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as Function;
    const AsyncGeneratorFunction =
      Object.getPrototypeOf(async function* () {}).constructor as Function;

    const SecureFunction = wrapConstructor(OriginalFunction, "Function");
    const SecureGeneratorFunction = wrapConstructor(
      GeneratorFunction,
      "GeneratorFunction",
    );
    const SecureAsyncFunction = wrapConstructor(AsyncFunction, "AsyncFunction");
    const SecureAsyncGeneratorFunction = wrapConstructor(
      AsyncGeneratorFunction,
      "AsyncGeneratorFunction",
    );

    lockValue(globalThis as object, "eval", secureEval);
    lockValue(globalThis as object, "Function", SecureFunction);
    for (const [prototype, ctor] of [
      [OriginalFunction.prototype, SecureFunction],
      [GeneratorFunction.prototype, SecureGeneratorFunction],
      [AsyncFunction.prototype, SecureAsyncFunction],
      [AsyncGeneratorFunction.prototype, SecureAsyncGeneratorFunction],
    ] as const) {
      lockValue(prototype, "constructor", ctor);
    }

    const wrapTimer = (
      originalTimer: (...args: unknown[]) => unknown,
      origin: "setTimeout" | "setInterval",
    ) =>
    (handler: unknown, ...rest: unknown[]) => {
      if (typeof handler === "string") {
        const nextDepth = enter(origin);
        runScan(handler, origin, nextDepth);
      }
      return Reflect.apply(originalTimer, globalThis, [handler, ...rest]);
    };

    for (const [name, origin] of [
      ["setTimeout", "setTimeout"],
      ["setInterval", "setInterval"],
    ] as const) {
      const timer = (globalThis as Record<string, unknown>)[name];
      if (typeof timer !== "function") continue;
      lockValue(
        globalThis as object,
        name,
        wrapTimer(timer as (...args: unknown[]) => unknown, origin),
      );
    }

    const secureDefineProperty = (
      target: object,
      property: PropertyKey,
      descriptor: PropertyDescriptor,
    ): object => {
      if (isProtectedProperty(protectedState, target, property)) {
        throw new Error(
          `KNT_ERROR_PERMISSION_DENIED: strict mode lock for ${String(property)}`,
        );
      }
      return Reflect.apply(
        originalDefineProperty as unknown as (...args: unknown[]) => object,
        Object,
        [target, property, descriptor],
      );
    };
    const secureDefineProperties = (
      target: object,
      properties: PropertyDescriptorMap & ThisType<unknown>,
    ): object => {
      for (const property of Reflect.ownKeys(properties as object)) {
        if (isProtectedProperty(protectedState, target, property)) {
          throw new Error(
            `KNT_ERROR_PERMISSION_DENIED: strict mode lock for ${String(property)}`,
          );
        }
      }
      return Reflect.apply(
        originalDefineProperties as unknown as (...args: unknown[]) => object,
        Object,
        [target, properties],
      );
    };

    lockValue(Object, "defineProperty", secureDefineProperty);
    lockValue(Object, "defineProperties", secureDefineProperties);

    g.__knittingStrictRuntimeGuardInstalled = true;
  } catch (error) {
    g.__knittingStrictRuntimeGuardInstalled = false;
    throw error;
  }
};
