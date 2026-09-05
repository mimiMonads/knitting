import { RUNTIME } from "../common/runtime.ts";
import { getNodeBuiltinModule } from "../common/node-compat.ts";
import { loadNodeNativeAddon } from "../connections/node-addons.ts";

type NodeModuleBuiltin = {
  createRequire: (url: string) => (specifier: string) => unknown;
};

type NodeCompletionDoorbellAddon = {
  createCompletionDoorbell: (notify: () => void) => bigint;
  ringCompletionDoorbell: (pointer: bigint) => boolean;
  unrefCompletionDoorbell: (pointer: bigint) => boolean;
  closeCompletionDoorbell: (pointer: bigint) => boolean;
};

const loadDoorbellAddon = (): NodeCompletionDoorbellAddon | undefined => {
  if (RUNTIME !== "node") return undefined;

  const nodeModule = getNodeBuiltinModule<NodeModuleBuiltin>("node:module");
  if (nodeModule === undefined) return undefined;

  try {
    return loadNodeNativeAddon<NodeCompletionDoorbellAddon>(
      nodeModule.createRequire(import.meta.url),
      "knitting_doorbell",
    );
  } catch {
    // Native wakeups are an optional fast path. A missing prebuild must retain
    // the portable Atomics.waitAsync dispatcher rather than preventing plain
    // thread workers from starting.
    return undefined;
  }
};

export type NodeCompletionDoorbell = {
  /** Process-local handle a Node thread worker may ring through the addon. */
  pointer: bigint;
  /** Invalidates the native handle after every worker that holds it has exited. */
  close: () => void;
};

/**
 * Bridge a Node worker thread into the host's libuv I/O phase. The addon owns
 * the `uv_async_t`; this wrapper owns the JS callback and makes missing native
 * prebuilds a normal capability fallback.
 */
export const createNodeCompletionDoorbell = (
  notify: () => void,
): NodeCompletionDoorbell | undefined => {
  const addon = loadDoorbellAddon();
  if (addon === undefined) return undefined;

  let pointer: bigint;
  let closed = false;
  try {
    pointer = addon.createCompletionDoorbell(() => {
      if (closed) return;
      try {
        notify();
      } catch {
        // An exception must not escape a libuv callback. A scheduled host
        // drain or the dispatcher watchdog still provides a liveness backstop.
      }
    });
    if (typeof pointer !== "bigint" || pointer === 0n) return undefined;
    // A dormant pool must not be kept alive solely by an idle uv_async_t.
    addon.unrefCompletionDoorbell(pointer);
  } catch {
    return undefined;
  }

  return {
    pointer,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        addon.closeCompletionDoorbell(pointer);
      } catch {
        // Shutdown can race Node environment teardown; the addon's environment
        // cleanup hook owns the remaining lifetime in that case.
      }
    },
  };
};

/** Rebuild the process-local native ring in a Node thread worker. */
export const createNodeCompletionNotifier = (
  pointer: bigint | undefined,
): (() => void) | undefined => {
  if (RUNTIME !== "node" || pointer === undefined || pointer === 0n) {
    return undefined;
  }

  const addon = loadDoorbellAddon();
  if (addon === undefined) return undefined;

  return () => {
    try {
      addon.ringCompletionDoorbell(pointer);
    } catch {
      // The host can close while a forced worker teardown is in flight. Its
      // return-lock watchdog covers that final in-flight publication.
    }
  };
};
