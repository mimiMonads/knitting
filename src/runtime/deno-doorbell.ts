import { RUNTIME } from "../common/runtime.ts";

type DenoUnsafeCallback = {
  pointer: unknown;
  close: () => void;
  unref?: () => number;
};

type DenoUnsafeCallbackConstructor = {
  threadSafe?: (
    definition: { parameters: readonly ["i32"]; result: "void" },
    callback: (lane: number) => void,
  ) => DenoUnsafeCallback;
};

type DenoUnsafeFnPointer = {
  call: (lane: number) => void;
};

type DenoUnsafeFnPointerConstructor = new (
  pointer: unknown,
  definition: { parameters: readonly ["i32"]; result: "void" },
) => DenoUnsafeFnPointer;

type DenoDoorbellApi = {
  permissions?: {
    querySync?: (descriptor: { name: "ffi" }) => { state?: string };
    requestSync?: (descriptor: { name: "ffi" }) => { state?: string };
  };
  UnsafeCallback?: DenoUnsafeCallbackConstructor;
  UnsafeFnPointer?: DenoUnsafeFnPointerConstructor;
  UnsafePointer?: {
    value: (pointer: unknown) => bigint;
    create: (pointer: bigint) => unknown;
  };
};

const getDeno = (): DenoDoorbellApi | undefined =>
  (globalThis as typeof globalThis & { Deno?: DenoDoorbellApi }).Deno;

export type DenoCompletionDoorbell = {
  /** A process-local callback pointer a Deno thread worker may invoke. */
  pointer: bigint;
  /** Routes a worker lane's ring to its host dispatcher. */
  listen: (lane: number, notify: () => void) => void;
  /** Lets an unclean shutdown exit without invalidating a live worker pointer. */
  unref: () => void;
  /** Invalidates the callback only after every worker that holds it has exited. */
  close: () => void;
};

/**
 * Creates Deno's native thread-to-event-loop bridge without loading a custom
 * library. `threadSafe()` is essential: ordinary UnsafeCallbacks may be
 * called cross-thread, but do not wake an idle Deno event loop.
 *
 * The default pool configuration asks Deno for FFI permission once, so the
 * native wake path is used whenever the caller approves it. `--allow-ffi`
 * skips the prompt; `--deny-ffi`, `--no-prompt`, or a rejection preserves the
 * portable polling dispatcher. Set `host.doorbell` to `false` to avoid asking.
 */
export const createDenoCompletionDoorbell = (): DenoCompletionDoorbell | undefined => {
  if (RUNTIME !== "deno") return undefined;

  const deno = getDeno();
  const queryPermission = deno?.permissions?.querySync;
  const requestPermission = deno?.permissions?.requestSync;
  const Callback = deno?.UnsafeCallback;
  const pointerValue = deno?.UnsafePointer?.value;
  if (
    typeof queryPermission !== "function" ||
    typeof Callback?.threadSafe !== "function" ||
    typeof pointerValue !== "function"
  ) {
    return undefined;
  }

  // `querySync` avoids a redundant prompt for an already granted or explicitly
  // denied capability. Only the normal `prompt` state asks, and a refusal
  // leaves the portable polling path intact.
  try {
    let state = queryPermission({ name: "ffi" }).state;
    if (state === "prompt" && typeof requestPermission === "function") {
      state = requestPermission({ name: "ffi" }).state;
    }
    if (state !== "granted") return undefined;
  } catch {
    return undefined;
  }

  const listeners = new Map<number, () => void>();
  let closed = false;
  let callback: DenoUnsafeCallback | undefined;
  try {
    callback = Callback.threadSafe(
      { parameters: ["i32"], result: "void" },
      (lane) => {
        if (closed) return;
        try {
          listeners.get(lane)?.();
        } catch {
          // FFI callbacks must never propagate an exception into the worker
          // thread that rang them. The dispatcher watchdog remains a final
          // liveness backstop if a host pump has already been closed.
        }
      },
    );
    const pointer = pointerValue(callback.pointer);
    if (typeof pointer !== "bigint" || pointer === 0n) {
      callback.close();
      return undefined;
    }

    return {
      pointer,
      listen: (lane, notify) => {
        if (!closed) listeners.set(lane, notify);
      },
      unref: () => {
        try {
          callback!.unref?.();
        } catch {
          // best effort; a runtime may already be tearing down its callback
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        listeners.clear();
        callback!.close();
      },
    };
  } catch {
    // Creating a callback is native code. Treat an unsupported Deno build just
    // like a denied FFI capability and keep the portable poll path.
    try {
      callback?.close();
    } catch {
      // best effort; callback may not have been initialized
    }
    return undefined;
  }
};

/**
 * Reconstruct a host-owned thread-safe callback in a Deno worker. The pointer
 * stays process-local and is never included in process-worker boot payloads.
 */
export const createDenoCompletionNotifier = (
  pointer: bigint | undefined,
): ((lane: number) => void) | undefined => {
  if (RUNTIME !== "deno" || pointer === undefined || pointer === 0n) {
    return undefined;
  }

  const deno = getDeno();
  const FnPointer = deno?.UnsafeFnPointer;
  const pointerCreate = deno?.UnsafePointer?.create;
  if (typeof FnPointer !== "function" || typeof pointerCreate !== "function") {
    return undefined;
  }

  try {
    const callback = new FnPointer(
      pointerCreate(pointer),
      { parameters: ["i32"], result: "void" },
    );
    return (lane: number) => callback.call(lane);
  } catch {
    return undefined;
  }
};
