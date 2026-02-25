import type { ResolvedPermisonProtocol } from "../../permison/protocol.ts";
import {
  StrictModeDepthError,
  StrictModeViolationError,
  resolveStrictModeOptions,
  scanCode,
} from "../../permison/strict-scan.ts";
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
  protocol?: ResolvedPermisonProtocol,
): boolean => {
  if (!protocol || protocol.enabled !== true) return false;
  if (protocol.unsafe === true) return false;
  if (protocol.mode !== "strict") return false;
  return true;
};

export const installStrictModeRuntimeGuard = (
  protocol?: ResolvedPermisonProtocol,
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
    let evalDepth = 0;

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
        const nextDepth = enter(origin);
        runScan(args.map((value) => String(value)).join("\n"), origin, nextDepth);
        evalDepth++;
        try {
          return Reflect.construct(
            originalCtor,
            args,
            new.target ? (new.target as Function) : originalCtor,
          );
        } finally {
          evalDepth--;
        }
      };

      try {
        originalDefineProperty(secure, "name", { value: origin });
      } catch {
      }
      try {
        originalDefineProperty(secure, STRICT_SECURE_CONSTRUCTOR, {
          value: true,
        });
      } catch {
      }
      return secure;
    };

    const originalEval = globalThis.eval;
    const secureEval = function (code: unknown): unknown {
      if (typeof code !== "string") return code;
      const nextDepth = enter("eval");
      runScan(code, "eval", nextDepth);
      evalDepth++;
      try {
        return Reflect.apply(
          originalEval as (source: string) => unknown,
          globalThis,
          [code],
        );
      } finally {
        evalDepth--;
      }
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

    defineLockedProperty(
      originalDefineProperty,
      protectedState,
      globalThis as object,
      "eval",
      secureEval,
    );
    defineLockedProperty(
      originalDefineProperty,
      protectedState,
      globalThis as object,
      "Function",
      SecureFunction,
    );
    defineLockedProperty(
      originalDefineProperty,
      protectedState,
      OriginalFunction.prototype,
      "constructor",
      SecureFunction,
    );
    defineLockedProperty(
      originalDefineProperty,
      protectedState,
      GeneratorFunction.prototype,
      "constructor",
      SecureGeneratorFunction,
    );
    defineLockedProperty(
      originalDefineProperty,
      protectedState,
      AsyncFunction.prototype,
      "constructor",
      SecureAsyncFunction,
    );
    defineLockedProperty(
      originalDefineProperty,
      protectedState,
      AsyncGeneratorFunction.prototype,
      "constructor",
      SecureAsyncGeneratorFunction,
    );

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

    if (typeof globalThis.setTimeout === "function") {
      defineLockedProperty(
        originalDefineProperty,
        protectedState,
        globalThis as object,
        "setTimeout",
        wrapTimer(globalThis.setTimeout as unknown as (...args: unknown[]) => unknown, "setTimeout"),
      );
    }
    if (typeof globalThis.setInterval === "function") {
      defineLockedProperty(
        originalDefineProperty,
        protectedState,
        globalThis as object,
        "setInterval",
        wrapTimer(
          globalThis.setInterval as unknown as (...args: unknown[]) => unknown,
          "setInterval",
        ),
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

    defineLockedProperty(
      originalDefineProperty,
      protectedState,
      Object,
      "defineProperty",
      secureDefineProperty,
    );

    g.__knittingStrictRuntimeGuardInstalled = true;
  } catch (error) {
    g.__knittingStrictRuntimeGuardInstalled = false;
    throw error;
  }
};
