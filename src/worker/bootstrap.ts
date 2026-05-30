import { RUNTIME } from "../common/runtime.ts";
import { toModuleUrl } from "../common/module-url.ts";
import { ProcessSharedBuffer } from "../connections/process-shared-buffer.ts";
import type { ProcessSharedBufferMetadata } from "../connections/process-shared-buffer.ts";
import type { WorkerData } from "../types.ts";

const DEFAULT_BOOTSTRAP_EXPORT_NAME = "default";

type WorkerBootstrapOptions = NonNullable<
  NonNullable<WorkerData["workerOptions"]>["bootstrap"]
>;

type WorkerBootstrapContext = {
  readonly thread: number;
  readonly totalNumberOfThread: number;
  readonly runtime: typeof RUNTIME;
};

type WorkerBootstrapFunction = (
  data: unknown,
  context: WorkerBootstrapContext,
) => unknown | Promise<unknown>;

const isWorkerBootstrapOptions = (
  value: unknown,
): value is WorkerBootstrapOptions => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerBootstrapOptions>;
  return typeof candidate.href === "string" &&
    candidate.href.length > 0 &&
    (
      candidate.name === undefined ||
      (typeof candidate.name === "string" && candidate.name.length > 0)
    );
};

const isProcessSharedBufferMetadata = (
  value: unknown,
): value is ProcessSharedBufferMetadata => {
  try {
    ProcessSharedBuffer.fromMetadata(value);
    return true;
  } catch {
    return false;
  }
};

const reviveWorkerBootstrapValue = (
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown => {
  if (isProcessSharedBufferMetadata(value)) {
    return ProcessSharedBuffer.fromMetadata(value);
  }
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) {
      out.push(reviveWorkerBootstrapValue(item, seen));
    }
    return out;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    out[key] = reviveWorkerBootstrapValue(item, seen);
  }
  return out;
};

export const runWorkerBootstrap = async ({
  bootstrap,
  thread,
  totalNumberOfThread,
}: {
  bootstrap: unknown;
  thread: number;
  totalNumberOfThread: number;
}): Promise<void> => {
  if (bootstrap === undefined) return;
  if (!isWorkerBootstrapOptions(bootstrap)) {
    throw new TypeError("worker.bootstrap must include a non-empty href");
  }

  const module = await import(toModuleUrl(bootstrap.href)) as Record<
    string,
    unknown
  >;
  const name = bootstrap.name ?? DEFAULT_BOOTSTRAP_EXPORT_NAME;
  const selected = module[name];
  if (typeof selected !== "function") {
    const available = Object.keys(module).join(", ");
    throw new TypeError(
      `worker.bootstrap expected export "${name}" from "${bootstrap.href}" to be a function.` +
        ` Available exports: ${available || "(none)"}`,
    );
  }

  const context: WorkerBootstrapContext = Object.freeze({
    thread,
    totalNumberOfThread,
    runtime: RUNTIME,
  });
  await (selected as WorkerBootstrapFunction)(
    reviveWorkerBootstrapValue(bootstrap.data),
    context,
  );
};
