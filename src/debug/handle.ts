/**
 * Worker-side debug handle. Lazily imported (see {@link ./gate.ts}) only when
 * `KNITTING_DEBUG` names at least one namespace, so neither this code nor the
 * baseline snapshot it takes exists when debug is off.
 *
 * Diagnostics go to stderr so they never corrupt a worker's stdout, and every
 * line is tagged with the worker id, runtime, and a clock in milliseconds since
 * the host's debug epoch, so host and worker lines interleave on one timeline.
 *
 * Raw `performance.now()` can't be compared across the thread/process boundary:
 * bun and deno give each worker its own time origin, and a process worker's
 * origin is its own process start. `performance.timeOrigin + performance.now()`
 * is comparable (measured within a few µs on bun, node and deno, for both
 * threads and processes), so the host sends that absolute value and each worker
 * rebases onto it once. Staying in the local `now()` frame afterwards keeps
 * full precision; the absolute sum alone only resolves ~0.24µs.
 */
import {
  describeGlobalKey,
  diffGlobals,
  type EnvSnapshot,
  snapshotGlobals,
} from "./env-diff.ts";

export type DebugInit = {
  /** Identity prefix for log tags, e.g. `"w0"` for a worker or `"main"`. */
  readonly name: string;
  readonly runtime: string;
  readonly namespaces: ReadonlySet<string>;
  /**
   * Host debug epoch as `timeOrigin + now()`. When absent (debug enabled only
   * inside the worker), the clock starts when this handle initialises.
   */
  readonly epoch?: number;
};

export type Debug = {
  /**
   * Is a namespace active? Capture this once before a hot loop and branch on
   * the boolean — never call per-iteration.
   */
  enabled: (namespace: string) => boolean;
  /** Emit a tagged line to stderr when `namespace` is active. */
  log: (namespace: string, message: string) => void;
  /**
   * Re-snapshot `globalThis` and report what changed since the previous phase.
   * Drives two-phase pollution attribution (e.g. `"bootstrap"` then
   * `"tasks"`), so you can see which loader injected which global. No-op unless
   * the `globals` namespace is active.
   */
  envPhase: (label: string) => void;
};

export const initDebug = (
  { name, runtime, namespaces, epoch }: DebugInit,
): Debug => {
  const all = namespaces.has("*");
  const enabled = (namespace: string): boolean =>
    all || namespaces.has(namespace);

  const base = epoch === undefined
    ? performance.now()
    : epoch - performance.timeOrigin;
  const tag = `${name}·${runtime}`;

  const log = (namespace: string, message: string): void => {
    if (!enabled(namespace)) return;
    const elapsed = (performance.now() - base).toFixed(1);
    console.error(`[${tag}·+${elapsed}ms] ${namespace}: ${message}`);
  };

  // Baseline for the environment diff, taken the moment debug initialises:
  // before worker bootstrap and before any task module is imported. Only paid
  // when `globals` tracing is actually on.
  let previous: EnvSnapshot | undefined = enabled("globals")
    ? snapshotGlobals()
    : undefined;

  const envPhase = (label: string): void => {
    if (previous === undefined) return;
    const current = snapshotGlobals();
    const { added, removed } = diffGlobals(previous, current);
    previous = current;

    if (added.length === 0 && removed.length === 0) {
      log("globals", `${label}: no new globals`);
      return;
    }
    if (added.length > 0) {
      log(
        "globals",
        `${label} +${added.length}: ${added.map(describeGlobalKey).join("  ")}`,
      );
    }
    if (removed.length > 0) {
      log("globals", `${label} -${removed.length}: ${removed.map(String).join("  ")}`);
    }
  };

  return { enabled, log, envPhase };
};
