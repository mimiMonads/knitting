// Worker helpers shared by every worker mode. Kept out of `process-worker.ts`
// so the thread and web-worker paths do not pull the process-worker module —
// and, through it, the whole native connections tree — into their bundles.
import { ProcessSharedBuffer } from "../connections/process-shared-buffer.ts";
import type { WorkerSettings } from "../types.ts";

export type SpawnedWorker = {
  terminate: () => unknown;
  unref?: () => unknown;
  postMessage?: (message: unknown) => void;
};

export type NodeWorkerLike = {
  on?: (
    event: "error" | "exit" | "message",
    listener: (...args: unknown[]) => void,
  ) => void;
};

const execFlagKey = (flag: string): string => flag.split("=", 1)[0]!;
const NODE_PERMISSION_EXEC_FLAGS = new Set<string>([
  "--permission",
  "--experimental-permission",
  "--experimental-config-file",
  "--experimental-default-config-file",
  "--allow-fs-read",
  "--allow-fs-write",
  "--allow-fs-vfs",
  "--allow-worker",
  "--allow-child-process",
  "--allow-env",
  "--allow-net",
  "--allow-addons",
  "--allow-ffi",
  "--allow-wasi",
  "--allow-inspector",
  "--allow-openssl-store",
]);
const NODE_WORKER_SAFE_EXEC_FLAGS = new Set<string>([
  "--experimental-ffi",
  "--experimental-transform-types",
  "--no-warnings",
  ...NODE_PERMISSION_EXEC_FLAGS,
]);

const isNodeWorkerSafeExecFlag = (flag: string): boolean =>
  NODE_WORKER_SAFE_EXEC_FLAGS.has(execFlagKey(flag));

export const isNodePermissionExecFlag = (flag: string): boolean =>
  NODE_PERMISSION_EXEC_FLAGS.has(execFlagKey(flag));

export const toWorkerSafeExecArgv = (
  flags: string[] | undefined,
): string[] | undefined => {
  if (!flags || flags.length === 0) return undefined;
  const filtered = flags.filter(isNodeWorkerSafeExecFlag);
  if (filtered.length === 0) return undefined;
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const flag of filtered) {
    if (seen.has(flag)) continue;
    seen.add(flag);
    deduped.push(flag);
  }
  return deduped;
};

/** Preserve process-worker runtime flags while replacing inherited permissions. */
export const toWorkerCompatExecArgv = (
  flags: string[] | undefined,
): string[] | undefined => {
  const safe = toWorkerSafeExecArgv(flags);
  if (!safe || safe.length === 0) return undefined;
  const compat = safe.filter((flag) => !isNodePermissionExecFlag(flag));
  return compat.length > 0 ? compat : undefined;
};

const droppedExecArgvWarnings = new Set<string>();

/**
 * Warn once per flag set when a `workerExecArgv` flag the caller asked for did
 * not reach the worker thread, instead of dropping it silently.
 */
export const warnDroppedWorkerExecArgv = (
  requested: string[] | undefined,
  applied: string[] | undefined,
): void => {
  if (!requested || requested.length === 0) return;
  const kept = new Set(applied ?? []);
  const dropped = requested.filter((flag) => !kept.has(flag));
  if (dropped.length === 0) return;
  const key = dropped.join(" ");
  if (droppedExecArgvWarnings.has(key)) return;
  droppedExecArgvWarnings.add(key);
  console.warn(
    `knitting: workerExecArgv ${dropped.join(", ")} cannot be applied to a ` +
      `worker thread and was dropped. V8 and process-wide flags must be ` +
      `passed to the host process instead.`,
  );
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const serializeWorkerBootstrapValue = (
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown => {
  if (value instanceof ProcessSharedBuffer) return value.toMetadata();
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) {
      out.push(serializeWorkerBootstrapValue(item, seen));
    }
    return out;
  }

  if (!isPlainRecord(value)) return value;

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    out[key] = serializeWorkerBootstrapValue(item, seen);
  }
  return out;
};

export const serializeWorkerBootstrapData = (
  options: WorkerSettings,
): WorkerSettings => {
  const bootstrap = options.bootstrap;
  if (bootstrap === undefined || bootstrap.data === undefined) return options;

  return {
    ...options,
    bootstrap: {
      ...bootstrap,
      data: serializeWorkerBootstrapValue(bootstrap.data),
    },
  };
};

// Bound the wait for process-worker exit.
const WORKER_EXIT_WAIT_MS = 2_000;

/** Terminate a worker, optionally waiting for it to exit. */
export const terminateWorkerQuietly = (
  worker: SpawnedWorker,
  awaitExit = false,
): Promise<void> => {
  try {
    if (!awaitExit) worker.unref?.();
    const exited = Promise.resolve(worker.terminate()).then(() => {}, () => {});
    if (!awaitExit) return exited;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        worker.unref?.();
        resolve();
      }, WORKER_EXIT_WAIT_MS);
      void exited.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    return Promise.resolve();
  }
};
