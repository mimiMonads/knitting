/**
 * Environment-diff primitive: snapshot the keys present on `globalThis`, then
 * later compare to see what the loaded code added, removed, or redefined.
 *
 * This is the core of "check what happens" debugging — a concrete before/after
 * of the real runtime a worker's modules created, not an aggregate metric. The
 * same snapshot/diff shape generalises to other ambient state (process
 * listeners, open handles, prototype patches); `globalThis` keys are the first
 * instance.
 */

export type EnvSnapshot = {
  readonly keys: ReadonlySet<string | symbol>;
};

/** Capture every own key on `globalThis`, including symbols. */
export const snapshotGlobals = (): EnvSnapshot => ({
  keys: new Set<string | symbol>(Reflect.ownKeys(globalThis)),
});

export type GlobalsDiff = {
  readonly added: (string | symbol)[];
  readonly removed: (string | symbol)[];
};

export const diffGlobals = (
  before: EnvSnapshot,
  after: EnvSnapshot,
): GlobalsDiff => {
  const added: (string | symbol)[] = [];
  const removed: (string | symbol)[] = [];
  for (const key of after.keys) {
    if (!before.keys.has(key)) added.push(key);
  }
  for (const key of before.keys) {
    if (!after.keys.has(key)) removed.push(key);
  }
  return { added, removed };
};

/**
 * Render a key with enough provenance to tell a fresh global from a
 * monkeypatch: its `typeof`/accessor kind plus writable/configurable/enumerable
 * flags (`w`/`c`/`e`).
 */
export const describeGlobalKey = (key: string | symbol): string => {
  const name = typeof key === "symbol" ? key.toString() : key;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  } catch {
    return name;
  }
  if (descriptor === undefined) return name;

  const kind = descriptor.get !== undefined || descriptor.set !== undefined
    ? "accessor"
    : typeof descriptor.value;
  const flags = `${descriptor.writable === false ? "" : "w"}${
    descriptor.configurable ? "c" : ""
  }${descriptor.enumerable ? "e" : ""}`;
  return flags.length > 0 ? `${name} (${kind} ${flags})` : `${name} (${kind})`;
};
