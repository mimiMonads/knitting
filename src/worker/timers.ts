type PauseOptions = {
  pauseInNanoseconds?: number;
};

export type NativeWaitU32 = (
  buffer: ArrayBuffer | SharedArrayBuffer,
  byteOffset: number,
  expected: number,
  timeoutMs?: number,
) => unknown;

// const object, not `enum`: Andromeda's Nova engine can't parse `enum`.
const Comment = {
  thisIsAHint: 0,
} as const;

const maybeGc = (() => {
  type GcHost = {
    gc?: (() => void) | undefined;
    global?: {
      gc?: (() => void) | undefined;
    } | undefined;
  };

  const host = globalThis as GcHost;
  const gc = typeof host.gc === "function"
    ? (() => host.gc!()) as () => void
    : undefined;

  if (gc) {
    try {
      delete host.gc;
    } catch {
      host.gc = undefined;
    }

    if (host.global) {
      try {
        delete host.global.gc;
      } catch {
        host.global.gc = undefined;
      }
    }
  }

  return gc ?? (() => {});
})();

const DEFAULT_PAUSE_TIME = 250;

const a_load = Atomics.load;
const a_store = Atomics.store;
const a_wait = typeof Atomics.wait === "function" ? Atomics.wait : undefined;
const p_now = performance.now.bind(performance);
// Some pages do not define SharedArrayBuffer; keep this module loadable there.
const waitFallbackView =
  a_wait === undefined || typeof SharedArrayBuffer !== "function"
    ? undefined
    : new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const a_pause: ((n: number) => void) | undefined = "pause" in Atomics
  ? (Atomics.pause as (n: number) => void)
  : undefined;
const runtimeGlobals = globalThis as typeof globalThis & {
  Deno?: unknown;
  process?: {
    platform?: string;
    versions?: { bun?: string; node?: string };
  };
};
const isPlainNodeWindows = runtimeGlobals.process?.platform === "win32" &&
  typeof runtimeGlobals.process?.versions?.node === "string" &&
  runtimeGlobals.process?.versions?.bun === undefined &&
  runtimeGlobals.Deno === undefined;

// Bun on Windows requires special handling for short waits and process rings.
export const IS_BUN_WINDOWS = runtimeGlobals.process?.platform === "win32" &&
  typeof runtimeGlobals.process?.versions?.bun === "string";

// Bun on Windows busy-spins for waits of 1ms or less; use a 2ms minimum.
const BUN_WINDOWS_MIN_WAIT_MS = 2;
const floorBunWindowsWait = (ms: number): number =>
  IS_BUN_WINDOWS && ms < BUN_WINDOWS_MIN_WAIT_MS ? BUN_WINDOWS_MIN_WAIT_MS : ms;

// Windows process workers cannot be woken through the native address-based
// wait, so cap their wait to 1ms and let polling rediscover work.
const nativeWaitTimeoutMs = (parkMs?: number): number =>
  isPlainNodeWindows ? 1 : Number.isFinite(parkMs) ? parkMs! : Infinity;

const pollingWaitTimeoutMs = (parkMs?: number): number =>
  floorBunWindowsWait(
    Number.isFinite(parkMs) ? Math.min(Math.max(parkMs!, 0), 1) : 1,
  );

export const whilePausing = ({ pauseInNanoseconds }: PauseOptions) => {
  const forNanoseconds = pauseInNanoseconds ?? DEFAULT_PAUSE_TIME;
  if (!a_pause || forNanoseconds <= 0) return () => {};

  return () => a_pause(forNanoseconds);
};

export const pauseGeneric = whilePausing({});

export const sleepUntilChanged = (
  {
    at,
    opView,
    pauseInNanoseconds,
    rxStatus,
    txStatus,
    enqueueLock,
    write,
    nativeWaitU32,
    useSharedMemoryWait = true,
    flushBeforeClaim = false,
  }: {
    opView: Int32Array;
    rxStatus: Int32Array;
    txStatus: Int32Array;
    pauseInNanoseconds?: number;
    at: number;
    enqueueLock: () => boolean;
    write?: () => number | boolean;
    nativeWaitU32?: NativeWaitU32;
    useSharedMemoryWait?: boolean;
    /** Stealing only: flush results before claiming more work. */
    flushBeforeClaim?: boolean;
  },
) => {
  const pause = pauseInNanoseconds === undefined
    ? pauseGeneric
    : whilePausing({ pauseInNanoseconds });

  const flushWrite = () => {
    if (!write) return false;
    const wrote = write();
    if (typeof wrote === "number") return wrote > 0;
    return wrote === true;
  };

  const tryProgress = flushBeforeClaim
    ? () => {
      const wrote = flushWrite();
      return enqueueLock() || wrote;
    }
    : () => {
      const claimed = enqueueLock();
      return flushWrite() || claimed;
    };

  return (
    value: number,
    spinMicroseconds: number,
    parkMs?: number,
  ) => {
    const until = p_now() + (spinMicroseconds / 1000);

    maybeGc();
    let spinChecks = 0;
    while (true) {
      if (
        a_load(opView, at) !== value ||
        txStatus[Comment.thisIsAHint] === 1
      ) return;

      if (tryProgress()) return;

      pause();
      if ((spinChecks++ & 63) === 0 && p_now() >= until) break;
    }

    if (tryProgress()) return;

    a_store(rxStatus, 0, 0);

    if (nativeWaitU32 !== undefined) {
      nativeWaitU32(
        opView.buffer,
        opView.byteOffset + (at * Int32Array.BYTES_PER_ELEMENT),
        value >>> 0,
        nativeWaitTimeoutMs(parkMs),
      );
    } else if (
      useSharedMemoryWait &&
      a_wait &&
      opView.buffer instanceof SharedArrayBuffer
    ) {
      // This path can be woken with Atomics.notify; an infinite debug wait is
      // intentional.
      a_wait!(
        opView,
        at,
        value,
        floorBunWindowsWait(parkMs ?? Infinity),
      );
    } else if (a_wait && waitFallbackView) {
      // This fallback is timeout-driven; keep the slice short for responsiveness.
      a_wait(waitFallbackView, 0, 0, pollingWaitTimeoutMs(parkMs));
    }

    a_store(rxStatus, 0, 1);
  };
};
