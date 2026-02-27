const BLOCKED_BINDING_GETTER = Symbol.for("knitting.strict.blockedBindingGetter");
const ROOT_GLOBAL = globalThis as object;
const OVERLAY_BINDINGS = ["require", "module", "globalThis", "self"] as const;
const isSelfReferenceBinding = (name: string): name is "globalThis" | "self" =>
  name === "globalThis" || name === "self";

export const STRICT_DYNAMIC_IMPORT_ERROR =
  "[Knitting Strict] Dynamic import() is blocked in sandboxed code. All modules must be declared statically in the task definition.";

type StrictBlockedGetter = (() => never) & {
  [BLOCKED_BINDING_GETTER]?: true;
};

type StrictBlockedBindingValue = {
  [Symbol.toPrimitive]: () => never;
  toString: () => never;
  valueOf: () => never;
};

const toBlockedBindingMessage = (binding: string): string =>
  `[Knitting Strict] ${binding} is blocked. Use static imports in your task module.`;

const createBlockedGetter = (binding: string): StrictBlockedGetter => {
  const getter = (() => {
    throw new Error(toBlockedBindingMessage(binding));
  }) as StrictBlockedGetter;
  getter[BLOCKED_BINDING_GETTER] = true;
  return getter;
};

const createBlockedBindingValue = (binding: string): StrictBlockedBindingValue => {
  const throwBlocked = (): never => {
    throw new Error(toBlockedBindingMessage(binding));
  };
  return {
    [Symbol.toPrimitive]: throwBlocked,
    toString: throwBlocked,
    valueOf: throwBlocked,
  };
};

export const isBlockedBindingDescriptor = (
  descriptor: PropertyDescriptor | undefined,
): boolean =>
  typeof descriptor?.get === "function" &&
  (descriptor.get as StrictBlockedGetter)[BLOCKED_BINDING_GETTER] === true;

export const createBlockedBindingDescriptor = (
  binding: string,
): PropertyDescriptor => ({
  get: createBlockedGetter(binding),
  enumerable: false,
  configurable: false,
});

const createEphemeralBlockedBindingDescriptor = (
  binding: string,
): PropertyDescriptor => ({
  get: createBlockedGetter(binding),
  enumerable: false,
  configurable: true,
});

const ignoreError = (action: () => void): void => {
  try {
    action();
  } catch {
  }
};

const tryDefineProperty = (
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): void => ignoreError(() => {
  Object.defineProperty(target, key, descriptor);
});

const mirrorCallableMetadata = ({
  target,
  source,
  name,
}: {
  target: Function;
  source: Function;
  name: string;
}): void => {
  for (const [key, value] of [
    ["name", name],
    ["length", source.length],
    ["toString", () => Function.prototype.toString.call(source)],
  ] as const) {
    tryDefineProperty(target, key, { value, configurable: true });
  }
};

const assertBindingHidden = (
  sandboxGlobal: object,
  binding: "require" | "module",
): void => {
  let proto: object | null = sandboxGlobal;
  while (proto !== null) {
    const isRoot = proto === sandboxGlobal;
    const descriptor = Object.getOwnPropertyDescriptor(proto, binding);
    if (!descriptor) {
      proto = Object.getPrototypeOf(proto);
      continue;
    }

    // Bun strict mode may inject a blocking getter on the root.
    if (isRoot && isBlockedBindingDescriptor(descriptor)) {
      proto = Object.getPrototypeOf(proto);
      continue;
    }

    const location = isRoot ? "on membrane global" : "on prototype chain";
    const message = binding === "require"
      ? `FATAL: require found ${location}`
      : `FATAL: module object found ${location}`;
    throw new Error(message);
  }
};

export const verifyNoRequire = (sandboxGlobal: object): void => {
  assertBindingHidden(sandboxGlobal, "require");
  assertBindingHidden(sandboxGlobal, "module");
};

export const createBlockedDynamicImportHook = () =>
  (_specifier: unknown): never => {
    throw new Error(STRICT_DYNAMIC_IMPORT_ERROR);
  };

export const createNodeVmDynamicImportOptions = () => ({
  importModuleDynamically: createBlockedDynamicImportHook(),
});

type GenericCallable = (this: unknown, ...args: unknown[]) => unknown;

export const createInjectedStrictCallable = <T extends (...args: any[]) => any>(
  target: T,
): T => {
  const callable = target as unknown as GenericCallable;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const g = ROOT_GLOBAL as Record<string, unknown>;
    const saved = new Map<(typeof OVERLAY_BINDINGS)[number], PropertyDescriptor | undefined>();
    const shadow = Object.create(g) as Record<string, unknown>;
    Object.defineProperty(
      shadow,
      "require",
      createEphemeralBlockedBindingDescriptor("require"),
    );
    Object.defineProperty(
      shadow,
      "module",
      createEphemeralBlockedBindingDescriptor("module"),
    );
    for (const name of ["globalThis", "self"] as const) {
      Object.defineProperty(shadow, name, {
        value: shadow,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    }

    for (const name of OVERLAY_BINDINGS) {
      const current = Object.getOwnPropertyDescriptor(g, name);
      saved.set(name, current);
      if (isSelfReferenceBinding(name)) {
        if (!current || current.configurable === true) {
          tryDefineProperty(g, name, {
            value: shadow,
            configurable: true,
            writable: true,
            enumerable: current?.enumerable ?? (name === "self"),
          });
        } else if ("value" in current && current.writable === true) {
          ignoreError(() => {
            g[name] = shadow;
          });
        }
        continue;
      }

      if (!current || current.configurable === true) {
        tryDefineProperty(g, name, createEphemeralBlockedBindingDescriptor(name));
        continue;
      }
      if ("value" in current && current.writable === true) {
        ignoreError(() => {
          g[name] = createBlockedBindingValue(name);
        });
      }
    }

    try {
      return Reflect.apply(callable, this, args);
    } finally {
      for (const name of OVERLAY_BINDINGS) {
        const previous = saved.get(name);
        if (previous) {
          if (previous.configurable === true) {
            tryDefineProperty(g, name, previous);
            continue;
          }
          if ("value" in previous && previous.writable === true) {
            ignoreError(() => {
              g[name] = previous.value;
            });
            continue;
          }
          tryDefineProperty(g, name, previous);
          continue;
        }
        ignoreError(() => {
          Reflect.deleteProperty(g as Record<string, unknown>, name);
        });
      }
    }
  } as unknown as T;

  mirrorCallableMetadata({
    target: wrapped as unknown as Function,
    source: target as unknown as Function,
    name: target.name || "strictInjectedCallable",
  });

  return wrapped;
};
