import { verifyNoRequire } from "./strict-import.ts";

type MembraneWrapper = (value: unknown) => unknown;

type MembraneReflectConstructors = {
  originalFunction?: Function;
  originalGeneratorFunction?: Function;
  originalAsyncFunction?: Function;
  originalAsyncGeneratorFunction?: Function;
  secureFunction?: Function;
  secureGeneratorFunction?: Function;
  secureAsyncFunction?: Function;
  secureAsyncGeneratorFunction?: Function;
};

type MembraneConfig = {
  allowConsole?: boolean;
  allowCrypto?: boolean;
  allowPerformance?: boolean;
  additionalGlobals?: Record<string, unknown>;
  customWrappers?: Record<string, MembraneWrapper>;
  reflectConstructors?: MembraneReflectConstructors;
};

type SafeReflect = typeof Reflect;

type SafeReflectOptions = {
  constructors?: MembraneReflectConstructors;
  protectedTargets?: Iterable<object>;
};

type MembraneGlobal = Record<string, unknown> & {
  globalThis: MembraneGlobal;
  self: MembraneGlobal;
  Reflect: SafeReflect;
};

const SAFE_CORE_GLOBAL_NAMES = [
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Date",
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "RegExp",
  "Int8Array",
  "Uint8Array",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "TextEncoder",
  "TextDecoder",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
] as const;

const SAFE_FUNCTION_GLOBAL_NAMES = [
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "decodeURI",
  "encodeURIComponent",
  "decodeURIComponent",
  "atob",
  "btoa",
  "structuredClone",
  "queueMicrotask",
  "clearTimeout",
  "clearInterval",
] as const;

const SAFE_LITERAL_GLOBAL_NAMES = [
  "Infinity",
  "NaN",
  "undefined",
] as const;

const SAFE_CONSOLE_METHODS = [
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "trace",
] as const;

const SAFE_REFLECT_METHODS = [
  "apply",
  "defineProperty",
  "deleteProperty",
  "get",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "has",
  "isExtensible",
  "ownKeys",
  "preventExtensions",
  "set",
] as const;

const BLOCKED_ADDITIONAL_GLOBAL_NAMES = new Set<string>([
  "Bun",
  "Deno",
  "process",
  "require",
  "module",
  "WebAssembly",
  "fetch",
  "Worker",
  "SharedWorker",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Proxy",
]);

const BLOCKED_ADDITIONAL_GLOBAL_PREFIXES = [
  "Bun.",
  "Deno.",
  "process.",
  "globalThis.",
] as const;

const CONSTRUCTOR_ROUTE_ENTRIES = [
  ["originalFunction", "secureFunction"],
  ["originalGeneratorFunction", "secureGeneratorFunction"],
  ["originalAsyncFunction", "secureAsyncFunction"],
  ["originalAsyncGeneratorFunction", "secureAsyncGeneratorFunction"],
] as const;

const hasOwn = (target: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

type LooseRecord = Record<string, unknown>;

const isObjectLike = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const isSelfBoundGlobalScopeTarget = (value: unknown): value is object => {
  if (!isObjectLike(value)) return false;
  const record = value as Record<PropertyKey, unknown>;
  return record.globalThis === value && record.self === value;
};

const defineLockedValue = (
  target: object,
  key: PropertyKey,
  value: unknown,
): void => {
  if (hasOwn(target, key)) {
    throw new Error(
      `KNT_ERROR_PERMISSION_DENIED: strict membrane attempted to overwrite ${String(key)}`,
    );
  }
  Object.defineProperty(target, key, {
    value,
    writable: false,
    configurable: false,
    enumerable: true,
  });
};

const getHostGlobalValue = (name: string): unknown =>
  (globalThis as unknown as Record<string, unknown>)[name];

const bindGlobalFunction = (name: string): ((...args: unknown[]) => unknown) | undefined => {
  const candidate = getHostGlobalValue(name);
  if (typeof candidate !== "function") return undefined;
  return candidate.bind(globalThis);
};

const createFrozenNamespace = (namespace: object): object => {
  const out = Object.create(null) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(namespace)) {
    const descriptor = Object.getOwnPropertyDescriptor(namespace, key);
    if (!descriptor) continue;
    const nextDescriptor: PropertyDescriptor = {
      enumerable: descriptor.enumerable ?? false,
      configurable: false,
    };
    if ("value" in descriptor) {
      const value = typeof descriptor.value === "function"
        ? descriptor.value.bind(namespace)
        : descriptor.value;
      nextDescriptor.value = value;
      nextDescriptor.writable = false;
    } else {
      nextDescriptor.get = descriptor.get;
      nextDescriptor.set = undefined;
    }
    Object.defineProperty(out, key, nextDescriptor);
  }
  return Object.freeze(out);
};

const createSafeConsole = (): object => {
  const hostConsole = (globalThis as unknown as { console?: LooseRecord }).console;
  const out = Object.create(null) as Record<string, (...args: unknown[]) => unknown>;
  for (const method of SAFE_CONSOLE_METHODS) {
    const target = hostConsole?.[method];
    const wrapped = typeof target === "function"
      ? (...args: unknown[]) =>
        Reflect.apply(
          target as (...input: unknown[]) => unknown,
          hostConsole,
          args,
        )
      : () => undefined;
    defineLockedValue(out, method, wrapped);
  }
  return Object.freeze(out);
};

const defineAppliedMethod = (
  target: Record<string, unknown>,
  source: LooseRecord,
  methodName: string,
): void => {
  const method = source[methodName];
  if (typeof method !== "function") return;
  defineLockedValue(
    target,
    methodName,
    (...args: unknown[]) =>
      Reflect.apply(method as (...input: unknown[]) => unknown, source, args),
  );
};

const createSafeCrypto = (): object | undefined => {
  const hostCrypto = (globalThis as unknown as { crypto?: LooseRecord }).crypto;
  if (!hostCrypto || typeof hostCrypto !== "object") return undefined;
  const out = Object.create(null) as Record<string, unknown>;
  defineAppliedMethod(out, hostCrypto, "getRandomValues");
  defineAppliedMethod(out, hostCrypto, "randomUUID");
  return Object.freeze(out);
};

const createSafePerformance = (): object | undefined => {
  const hostPerformance =
    (globalThis as unknown as { performance?: LooseRecord }).performance;
  if (!hostPerformance || typeof hostPerformance !== "object") return undefined;
  const out = Object.create(null) as Record<string, unknown>;
  defineAppliedMethod(out, hostPerformance, "now");
  if (out.now === undefined) return undefined;
  return Object.freeze(out);
};

const blockedReferences = (): unknown[] => {
  const g = globalThis as unknown as Record<string, unknown>;
  return [
    globalThis,
    g.process,
    g.Bun,
    g.Deno,
    g.require,
    g.module,
    g.WebAssembly,
    g.fetch,
    g.Worker,
    g.SharedWorker,
    g.XMLHttpRequest,
    g.WebSocket,
    g.EventSource,
    g.Proxy,
  ].filter((entry) => entry != null);
};

const assertAdditionalGlobalName = (name: string): void => {
  if (name.length === 0) {
    throw new Error(
      "KNT_ERROR_PERMISSION_DENIED: strict membrane additional global name must not be empty",
    );
  }
  if (BLOCKED_ADDITIONAL_GLOBAL_NAMES.has(name)) {
    throw new Error(
      `KNT_ERROR_PERMISSION_DENIED: strict membrane additional global "${name}" maps to runtime-native API`,
    );
  }
  for (const prefix of BLOCKED_ADDITIONAL_GLOBAL_PREFIXES) {
    if (name.startsWith(prefix)) {
      throw new Error(
        `KNT_ERROR_PERMISSION_DENIED: strict membrane additional global "${name}" maps to runtime-native API`,
      );
    }
  }
};

const assertAdditionalGlobalValue = (name: string, value: unknown): void => {
  for (const blocked of blockedReferences()) {
    if (value === blocked) {
      throw new Error(
        `KNT_ERROR_PERMISSION_DENIED: strict membrane additional global "${name}" references runtime-native API`,
      );
    }
  }
};

const freezeDeep = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (!descriptor) continue;
    if ("value" in descriptor) freezeDeep(descriptor.value, seen);
    if (typeof descriptor.get === "function") freezeDeep(descriptor.get, seen);
    if (typeof descriptor.set === "function") freezeDeep(descriptor.set, seen);
  }
  try {
    Object.freeze(objectValue);
  } catch (error) {
    throw new Error(
      `KNT_ERROR_PERMISSION_DENIED: strict membrane additional global is not freezable (${String(error)})`,
    );
  }
  return value;
};

const routeConstructor = (
  candidate: unknown,
  constructors?: MembraneReflectConstructors,
): Function | undefined => {
  if (!constructors || typeof candidate !== "function") return undefined;
  for (const [originalKey, secureKey] of CONSTRUCTOR_ROUTE_ENTRIES) {
    const original = constructors[originalKey];
    const secure = constructors[secureKey];
    if (original && secure && candidate === original) return secure;
  }
  return undefined;
};

const toConstructor = (
  candidate: unknown,
  constructors?: MembraneReflectConstructors,
): Function => {
  const routed = routeConstructor(candidate, constructors);
  if (routed) return routed;
  if (typeof candidate !== "function") {
    throw new TypeError("Reflect.construct target must be a constructor");
  }
  return candidate;
};

const toSafeReflectOptions = (
  input?: MembraneReflectConstructors | SafeReflectOptions,
): SafeReflectOptions => {
  if (!input) return {};
  if (
    typeof input === "object" &&
    (
      Object.prototype.hasOwnProperty.call(input, "constructors") ||
      Object.prototype.hasOwnProperty.call(input, "protectedTargets")
    )
  ) {
    return input as SafeReflectOptions;
  }
  return {
    constructors: input as MembraneReflectConstructors,
  };
};

function assertReflectMutationAllowed(
  apiName: "Reflect.defineProperty" | "Reflect.setPrototypeOf",
  target: unknown,
  protectedTargets: Set<object>,
): asserts target is object {
  if (!isObjectLike(target)) return;
  if (
    protectedTargets.has(target) ||
    Object.isFrozen(target) ||
    isSelfBoundGlobalScopeTarget(target)
  ) {
    throw new Error(
      `KNT_ERROR_PERMISSION_DENIED: strict membrane blocked ${apiName} on protected target`,
    );
  }
}

export const createSafeReflect = (
  input?: MembraneReflectConstructors | SafeReflectOptions,
): SafeReflect => {
  const options = toSafeReflectOptions(input);
  const constructors = options.constructors;
  const protectedTargets = new Set(options.protectedTargets ?? []);
  const out = Object.create(null) as Record<string, unknown>;
  for (const method of SAFE_REFLECT_METHODS) {
    if (method === "defineProperty") continue;
    const reflectMethod = (Reflect as unknown as Record<string, unknown>)[method];
    if (typeof reflectMethod !== "function") continue;
    defineLockedValue(out, method, reflectMethod.bind(Reflect));
  }

  defineLockedValue(
    out,
    "defineProperty",
    (
      target: object,
      property: PropertyKey,
      attributes: PropertyDescriptor,
    ): boolean => {
      assertReflectMutationAllowed(
        "Reflect.defineProperty",
        target,
        protectedTargets,
      );
      return Reflect.defineProperty(target, property, attributes);
    },
  );
  defineLockedValue(
    out,
    "setPrototypeOf",
    (target: object, proto: object | null): boolean => {
      assertReflectMutationAllowed(
        "Reflect.setPrototypeOf",
        target,
        protectedTargets,
      );
      return Reflect.setPrototypeOf(target, proto);
    },
  );
  defineLockedValue(
    out,
    "construct",
    (
      target: Function,
      argArray: ArrayLike<unknown>,
      newTarget?: Function,
    ): unknown => {
      const targetCtor = toConstructor(target, constructors);
      const newTargetCtor = newTarget == null
        ? targetCtor
        : toConstructor(newTarget, constructors);
      return Reflect.construct(
        targetCtor,
        Array.from(argArray as ArrayLike<unknown>),
        newTargetCtor,
      );
    },
  );

  return Object.freeze(out) as SafeReflect;
};

function assertObjectGlobalMutationAllowed(
  apiName: "Object.defineProperty" | "Object.defineProperties",
  membraneGlobal: MembraneGlobal,
  target: unknown,
): asserts target is object {
  if (!isObjectLike(target)) return;
  if (
    target === membraneGlobal ||
    target === globalThis ||
    isSelfBoundGlobalScopeTarget(target)
  ) {
    throw new Error(
      `KNT_ERROR_PERMISSION_DENIED: strict membrane blocked ${apiName} on global scope`,
    );
  }
}

const createSafeObjectConstructor = (
  membraneGlobal: MembraneGlobal,
): ObjectConstructor => {
  const OriginalObject = Object;
  const secureObject = function (this: unknown, ...args: unknown[]) {
    if (new.target) {
      return Reflect.construct(
        OriginalObject as unknown as Function,
        args,
        new.target as Function,
      );
    }
    return Reflect.apply(
      OriginalObject as unknown as (...input: unknown[]) => unknown,
      undefined,
      args,
    );
  } as unknown as ObjectConstructor;

  for (const key of Reflect.ownKeys(OriginalObject)) {
    const descriptor = Object.getOwnPropertyDescriptor(OriginalObject, key);
    if (!descriptor) continue;
    if (key === "defineProperty") {
      descriptor.value = (
        target: object,
        property: PropertyKey,
        attributes: PropertyDescriptor,
      ): object => {
        assertObjectGlobalMutationAllowed(
          "Object.defineProperty",
          membraneGlobal,
          target,
        );
        return OriginalObject.defineProperty(target, property, attributes);
      };
    } else if (key === "defineProperties") {
      descriptor.value = (
        target: object,
        properties: PropertyDescriptorMap & ThisType<unknown>,
      ): object => {
        assertObjectGlobalMutationAllowed(
          "Object.defineProperties",
          membraneGlobal,
          target,
        );
        return OriginalObject.defineProperties(target, properties);
      };
    }
    try {
      Object.defineProperty(secureObject, key, descriptor);
    } catch {
    }
  }

  try {
    Object.setPrototypeOf(secureObject, OriginalObject);
  } catch {
  }
  try {
    (secureObject as unknown as { prototype?: unknown }).prototype =
      OriginalObject.prototype;
  } catch {
  }
  return secureObject;
};

export const createMembraneGlobal = (
  config: MembraneConfig = {},
): MembraneGlobal => {
  const allowConsole = config.allowConsole === true;
  const allowCrypto = config.allowCrypto !== false;
  const allowPerformance = config.allowPerformance !== false;
  const membraneGlobal = Object.create(null) as MembraneGlobal;
  const protectedTargets = new Set<object>([membraneGlobal]);

  for (const name of SAFE_CORE_GLOBAL_NAMES) {
    if (name === "Object") continue;
    const value = getHostGlobalValue(name);
    if (value === undefined) continue;
    defineLockedValue(membraneGlobal, name, value);
  }
  const safeObject = createSafeObjectConstructor(membraneGlobal);
  defineLockedValue(membraneGlobal, "Object", safeObject);

  for (const name of SAFE_LITERAL_GLOBAL_NAMES) {
    defineLockedValue(membraneGlobal, name, getHostGlobalValue(name));
  }

  for (const name of SAFE_FUNCTION_GLOBAL_NAMES) {
    const bound = bindGlobalFunction(name);
    if (!bound) continue;
    defineLockedValue(membraneGlobal, name, bound);
  }

  const safeMath = createFrozenNamespace(Math);
  defineLockedValue(membraneGlobal, "Math", safeMath);
  protectedTargets.add(safeMath);
  const safeJSON = Object.freeze(
    Object.create(null, {
      parse: {
        value: JSON.parse.bind(JSON),
        writable: false,
        configurable: false,
        enumerable: true,
      },
      stringify: {
        value: JSON.stringify.bind(JSON),
        writable: false,
        configurable: false,
        enumerable: true,
      },
    }),
  );
  defineLockedValue(
    membraneGlobal,
    "JSON",
    safeJSON,
  );
  protectedTargets.add(safeJSON);
  const safeReflect = createSafeReflect({
    constructors: config.reflectConstructors,
    protectedTargets,
  });
  defineLockedValue(
    membraneGlobal,
    "Reflect",
    safeReflect,
  );
  protectedTargets.add(safeReflect);

  if (allowConsole) {
    const safeConsole = createSafeConsole();
    defineLockedValue(membraneGlobal, "console", safeConsole);
    protectedTargets.add(safeConsole);
  }
  if (allowCrypto) {
    const safeCrypto = createSafeCrypto();
    if (safeCrypto) {
      defineLockedValue(membraneGlobal, "crypto", safeCrypto);
      protectedTargets.add(safeCrypto);
    }
  }
  if (allowPerformance) {
    const safePerformance = createSafePerformance();
    if (safePerformance) {
      defineLockedValue(membraneGlobal, "performance", safePerformance);
      protectedTargets.add(safePerformance);
    }
  }

  const additionalGlobals = config.additionalGlobals ?? {};
  const wrappers = config.customWrappers ?? {};
  for (const [name, originalValue] of Object.entries(additionalGlobals)) {
    assertAdditionalGlobalName(name);
    const wrapped = typeof wrappers[name] === "function"
      ? wrappers[name]!(originalValue)
      : originalValue;
    assertAdditionalGlobalValue(name, wrapped);
    freezeDeep(wrapped);
    if (isObjectLike(wrapped) && Object.isFrozen(wrapped)) {
      protectedTargets.add(wrapped);
    }
    defineLockedValue(membraneGlobal, name, wrapped);
  }

  defineLockedValue(membraneGlobal, "globalThis", membraneGlobal);
  defineLockedValue(membraneGlobal, "self", membraneGlobal);

  verifyNoRequire(membraneGlobal as unknown as object);
  return Object.freeze(membraneGlobal);
};

export type {
  MembraneConfig,
  MembraneGlobal,
  MembraneReflectConstructors,
  SafeReflect,
};
