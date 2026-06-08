/**
 * Zero-cost debug gate.
 *
 * Read once at module load from `KNITTING_DEBUG`. This module is deliberately
 * tiny and dependency-light: importing it must never pull in the logger or the
 * environment-diff machinery. Callers branch on {@link DEBUG_ENABLED} and only
 * then `await import("./handle.ts")`, so when debug is off nothing else under
 * `src/debug` is ever loaded — literally zero cost, not merely cheap.
 *
 * `KNITTING_DEBUG` is a comma-separated list of namespaces:
 *   KNITTING_DEBUG=host,imports      # only those
 *   KNITTING_DEBUG=*                 # everything
 */
import { getNodeProcess } from "../common/node-compat.ts";
import type { DebugOptions } from "../types.ts";

const readEnv = (key: string): string | undefined => {
  // Deno: `process.env` exists under node-compat, but reading it may require
  // --allow-env. Prefer the typed `Deno.env` and swallow permission errors.
  const denoEnv = (globalThis as typeof globalThis & {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
  }).Deno?.env;
  if (typeof denoEnv?.get === "function") {
    try {
      return denoEnv.get(key);
    } catch {
      /* env permission denied — fall through to node/bun */
    }
  }
  try {
    return getNodeProcess()?.env?.[key];
  } catch {
    return undefined;
  }
};

const raw = readEnv("KNITTING_DEBUG");

/** Namespaces explicitly requested via `KNITTING_DEBUG`. */
export const DEBUG_NAMESPACES: ReadonlySet<string> = new Set(
  (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0),
);

/**
 * True when at least one namespace is requested via the env var alone. Guards
 * the env-only paths; callers that also accept a `debug` option should use
 * {@link resolveDebugNamespaces} instead.
 */
export const DEBUG_ENABLED = DEBUG_NAMESPACES.size > 0;

/**
 * Merge the namespaces requested through the `debug` pool option with those from
 * `KNITTING_DEBUG`; either source can enable a namespace. Returns an empty set
 * when nothing is requested, so callers use `.size === 0` to keep the rest of
 * `src/debug` unloaded — zero cost when off.
 */
export const resolveDebugNamespaces = (debug?: DebugOptions): Set<string> => {
  const namespaces = new Set<string>(DEBUG_NAMESPACES);

  if (debug === true) {
    namespaces.add("*");
  } else if (debug !== undefined && debug !== false) {
    for (const [key, value] of Object.entries(debug)) {
      if (value === true) namespaces.add(key);
    }
  }

  return namespaces;
};

/** True when `namespace` (or `"*"`) is active for the given `debug` config + env. */
export const debugHas = (
  debug: DebugOptions | undefined,
  namespace: string,
): boolean => {
  const namespaces = resolveDebugNamespaces(debug);
  return namespaces.has("*") || namespaces.has(namespace);
};
