type PauseOptions = {
  pauseInNanoseconds?: number;
};

export type NativeWaitU32 = (
  buffer: ArrayBuffer | SharedArrayBuffer,
  byteOffset: number,
  expected: number,
  timeoutMs?: number,
) => unknown;

enum Comment {
  thisIsAHint = 0,
}

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
const waitFallbackView = a_wait === undefined
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

// Windows has no working cross-process wake. The native wake (WakeByAddress)
// is keyed to a virtual address, so a host cannot wake a process worker parked
// on the same physical page mapped at a different address in the child — the
// addon's FutexWake is a no-op there. A parked Windows Node process worker can
// therefore never be signalled and must rediscover work by polling. Cap the
// native wait at 1ms so it re-checks every millisecond instead of sleeping the
// full parkMs (up to seconds); the long park with no wake is what made CI
// runners appear to hang. The native wait already polls internally, so this is
// just bounding each poll slice.
const nativeWaitTimeoutMs = (parkMs?: number): number =>
  isPlainNodeWindows ? 1 : parkMs ?? 60;

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
  },
) => {
  const pause = pauseInNanoseconds === undefined
    ? pauseGeneric
    : whilePausing({ pauseInNanoseconds });

  const tryProgress = () => {
    let progressed = false;

    if (enqueueLock()) progressed = true;

    if (write) {
      const wrote = write();
      if (typeof wrote === "number") {
        if (wrote > 0) progressed = true;
      } else if (wrote === true) {
        progressed = true;
      }
    }

    return progressed;
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
      a_wait!(
        opView,
        at,
        value,
        parkMs ?? 60,
      );
    } else if (a_wait && waitFallbackView) {
      a_wait(waitFallbackView, 0, 0, parkMs ?? 1);
    }

    a_store(rxStatus, 0, 1);
  };
};
