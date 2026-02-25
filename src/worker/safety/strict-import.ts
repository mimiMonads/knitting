const BLOCKED_BINDING_GETTER = Symbol.for("knitting.strict.blockedBindingGetter");
const ROOT_GLOBAL = globalThis as object;

export const STRICT_DYNAMIC_IMPORT_ERROR =
  "[Knitting Strict] Dynamic import() is blocked in sandboxed code. All modules must be declared statically in the task definition.";

type StrictBlockedGetter = (() => never) & {
  [BLOCKED_BINDING_GETTER]?: true;
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

    if (binding === "require") {
      throw new Error(
        isRoot
          ? "FATAL: require found on membrane global"
          : "FATAL: require found on prototype chain",
      );
    }

    throw new Error(
      isRoot
        ? "FATAL: module object found on membrane global"
        : "FATAL: module object found on prototype chain",
    );
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
    const names = ["require", "module", "globalThis", "self"] as const;
    const saved = new Map<(typeof names)[number], PropertyDescriptor | undefined>();
    const shadow = Object.create(g) as Record<string, unknown>;
    Object.defineProperty(shadow, "require", createEphemeralBlockedBindingDescriptor("require"));
    Object.defineProperty(shadow, "module", createEphemeralBlockedBindingDescriptor("module"));
    Object.defineProperty(shadow, "globalThis", {
      value: shadow,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    Object.defineProperty(shadow, "self", {
      value: shadow,
      configurable: true,
      writable: true,
      enumerable: true,
    });

    for (const name of names) {
      const current = Object.getOwnPropertyDescriptor(g, name);
      saved.set(name, current);
      if (name === "globalThis" || name === "self") {
        if (!current || current.configurable === true) {
          try {
            Object.defineProperty(g, name, {
              value: shadow,
              configurable: true,
              writable: true,
              enumerable: current?.enumerable ?? (name === "self"),
            });
          } catch {
          }
        } else if ("value" in current && current.writable === true) {
          try {
            g[name] = shadow;
          } catch {
          }
        }
        continue;
      }

      if (current && current.configurable !== true) continue;
      try {
        Object.defineProperty(
          g,
          name,
          createEphemeralBlockedBindingDescriptor(name),
        );
      } catch {
      }
    }

    try {
      return Reflect.apply(callable, this, args);
    } finally {
      for (const name of names) {
        const previous = saved.get(name);
        if (previous) {
          try {
            Object.defineProperty(g, name, previous);
          } catch {
          }
          continue;
        }
        try {
          Reflect.deleteProperty(g as Record<string, unknown>, name);
        } catch {
        }
      }
    }
  } as unknown as T;

  try {
    Object.defineProperty(wrapped, "name", {
      value: target.name || "strictInjectedCallable",
      configurable: true,
    });
  } catch {
  }
  try {
    Object.defineProperty(wrapped, "length", {
      value: target.length,
      configurable: true,
    });
  } catch {
  }
  try {
    Object.defineProperty(wrapped, "toString", {
      value: () => Function.prototype.toString.call(target),
      configurable: true,
    });
  } catch {
  }

  return wrapped;
};
