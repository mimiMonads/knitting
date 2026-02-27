type GlobalRecord = Record<PropertyKey, unknown>;

const BUILTIN_PROTOTYPES: unknown[] = [
  Object.prototype,
  Array.prototype,
  String.prototype,
  Number.prototype,
  Boolean.prototype,
  Function.prototype,
  RegExp.prototype,
  Date.prototype,
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  Promise.prototype,
  Error.prototype,
  TypeError.prototype,
  RangeError.prototype,
  SyntaxError.prototype,
  Symbol.prototype,
];

const tryRun = (action: () => void): void => {
  try {
    action();
  } catch {
  }
};

const FROZEN_RUNTIME_SLOTS = [
  "require",
  "module",
  "__knittingStrictSandboxRuntime",
  "__knittingStrictSandboxRuntimeMap",
] as const;
const FROZEN_RUNTIME_SLOT_SET = new Set<string>(FROZEN_RUNTIME_SLOTS);

const isEqualDataDescriptor = (
  a: PropertyDescriptor,
  b: PropertyDescriptor,
): boolean =>
  Object.is(a.value, b.value) &&
  a.writable === b.writable &&
  (a.enumerable ?? false) === (b.enumerable ?? false) &&
  (a.configurable ?? false) === (b.configurable ?? false);

const isEqualAccessorDescriptor = (
  a: PropertyDescriptor,
  b: PropertyDescriptor,
): boolean =>
  a.get === b.get &&
  a.set === b.set &&
  (a.enumerable ?? false) === (b.enumerable ?? false) &&
  (a.configurable ?? false) === (b.configurable ?? false);

const hasDescriptorChanged = (
  before: PropertyDescriptor | undefined,
  after: PropertyDescriptor,
): boolean => {
  if (!before) return true;
  const beforeIsData = "value" in before || "writable" in before;
  const afterIsData = "value" in after || "writable" in after;
  if (beforeIsData !== afterIsData) return true;
  return beforeIsData
    ? !isEqualDataDescriptor(before, after)
    : !isEqualAccessorDescriptor(before, after);
};

const tryFreeze = (value: unknown): void => {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return;
  }
  tryRun(() => {
    Object.freeze(value);
  });
};

const lockAddedGlobal = (
  g: GlobalRecord,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): void => {
  if ("value" in descriptor) {
    // Spec: cast-on globals must freeze assigned object/function values.
    tryFreeze(descriptor.value);
    tryRun(() => {
      Object.defineProperty(g, key, {
        value: descriptor.value,
        writable: false,
        configurable: false,
        enumerable: descriptor.enumerable ?? true,
      });
    });
    return;
  }

  tryRun(() => {
    Object.defineProperty(g, key, {
      get: descriptor.get,
      set: undefined,
      configurable: false,
      enumerable: descriptor.enumerable ?? false,
    });
  });
};

const ensureWritableSlot = (
  g: GlobalRecord,
  key: string,
): void => {
  if (Object.getOwnPropertyDescriptor(g, key)) return;
  tryRun(() => {
    Object.defineProperty(g, key, {
      value: undefined,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  });
};

export const freezeEnvironment = ({
  baselineGlobalDescriptors,
}: {
  baselineGlobalDescriptors: Map<PropertyKey, PropertyDescriptor>;
}): void => {
  for (const proto of BUILTIN_PROTOTYPES) {
    tryFreeze(proto);
  }

  const g = globalThis as unknown as GlobalRecord;

  for (const key of FROZEN_RUNTIME_SLOTS) {
    ensureWritableSlot(g, key);
  }

  for (const key of Reflect.ownKeys(g)) {
    if (typeof key === "string" && FROZEN_RUNTIME_SLOT_SET.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(g, key);
    if (!descriptor) continue;
    const before = baselineGlobalDescriptors.get(key);
    if (!hasDescriptorChanged(before, descriptor)) continue;
    lockAddedGlobal(g, key, descriptor);
  }

  tryRun(() => {
    Object.seal(g);
  });
};
