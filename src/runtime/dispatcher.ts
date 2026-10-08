import { type MultiQueue } from "./tx-queue.ts";
import { type MainSignal } from "../ipc/transport/shared-memory.ts";
import {
  createRuntimeMessageChannel,
  type RuntimeMessageChannelLike,
  type RuntimeMessagePortLike,
} from "../common/worker-runtime.ts";
import { RUNTIME, SET_IMMEDIATE } from "../common/runtime.ts";
import type { DispatcherSettings } from "../types.ts";

/** Runtime-specific macrotask primitive used by the host dispatcher. */
const IMMEDIATE_PUMP = RUNTIME === "deno" || RUNTIME === "node"
  ? SET_IMMEDIATE
  : undefined;

// Polling tolerates a wider free window; a doorbell should arm promptly.
const POLL_STALL_FREE_LOOPS = 128;
const DOORBELL_STALL_FREE_LOOPS = 1;

export const hostDispatcherLoop = ({
  signalBox: {
    opView,
    txStatus,
    rxStatus,
  },
  queue: {
    completeFrame,
    hasPendingFrames,
    flushToWorker,
    txIdle,
    waitForCompletion,
    armCompletionNotifier,
    setCompletionWaiterArmed,
  },
  channelHandler,
  dispatcherOptions,
  notifySignal,
  wakeAfterPass,
  crossProcess,
  nativeCompletionDoorbell,
  processCompletionDoorbell,
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
  dispatcherOptions?: DispatcherSettings;
  notifySignal?: () => void;
  /**
   * Runs at the end of every drain pass. Defaults to waking this lane's worker
   * if it is parked; a shared queue supplies its own policy.
   */
  wakeAfterPass?: () => void;
  /** Workers live in other processes; disables only the atomic doorbell. */
  crossProcess?: boolean;
  /** A runtime-native completion ring that wakes the host event loop. */
  nativeCompletionDoorbell?: boolean;
  /** A process IPC completion doorbell that wakes the host event loop. */
  processCompletionDoorbell?: boolean;
}) => {
  const a_add = Atomics.add;
  const a_load = Atomics.load;
  const a_notify = Atomics.notify;
  const canNotifySignal = opView.buffer instanceof SharedArrayBuffer;
  const wakeSignal = notifySignal ??
    (() => {
      if (canNotifySignal) a_notify(opView, 0, 1);
    });
  // Bump rather than store a constant: the worker parks on the value it last
  // read, so only a changed word makes a ring that lands before its wait count.
  const wakeLane = () => {
    a_add(opView, 0, 1);
    wakeSignal();
  };
  const wakeIfParked = wakeAfterPass ?? (() => {
    if (a_load(rxStatus, 0) === 0) wakeLane();
  });
  const notify = () => channelHandler.notify();
  // Atomics waiters are process-local, so cross-process workers cannot use this
  // doorbell.
  const canUseAtomicDoorbell =
    (RUNTIME === "bun" || RUNTIME === "node" || RUNTIME === "andromeda") &&
    typeof Atomics.waitAsync === "function";
  const canUseDoorbell = (dispatcherOptions?.doorbell ?? true) &&
    (
      processCompletionDoorbell === true ||
      (crossProcess !== true &&
        (canUseAtomicDoorbell || nativeCompletionDoorbell === true))
    );
  let doorbellEnabled = canUseDoorbell;
  let doorbellArmed = false;
  let doorbellEpoch = 0 | 0;
  const DOORBELL_WATCHDOG_MS = 1000;
  let doorbellWatchdog: ReturnType<typeof setTimeout> | undefined;
  const clearDoorbellWatchdog = () => {
    if (doorbellWatchdog === undefined) return;
    clearTimeout(doorbellWatchdog);
    doorbellWatchdog = undefined;
  };
  let stallCount = 0 | 0;
  const requestedStallFreeLoops = dispatcherOptions?.stallFreeLoops;
  let stallFreeLoops = requestedStallFreeLoops !== undefined
    ? Math.max(0, requestedStallFreeLoops | 0)
    : canUseDoorbell
    ? DOORBELL_STALL_FREE_LOOPS
    : POLL_STALL_FREE_LOOPS;
  const MAX_BACKOFF_MS = Math.max(
    0,
    (dispatcherOptions?.maxBackoffMs ?? 10) | 0,
  );
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  // inFlight prevents re-entrancy when pool.ts fires check() concurrently
  // from both send() and the channel callback. Cheaper than try/finally.
  let inFlight = false;

  const cancelDoorbell = () => {
    if (!doorbellArmed) return;
    clearDoorbellWatchdog();
    doorbellEpoch = (doorbellEpoch + 1) | 0;
    doorbellArmed = false;
    setCompletionWaiterArmed(false);
  };

  const armDoorbell = () => {
    if (!doorbellEnabled || doorbellArmed === true) {
      if (!doorbellEnabled) notify();
      return;
    }

    const token = (doorbellEpoch + 1) | 0;
    doorbellEpoch = token;
    doorbellArmed = true;
    let woke = false;
    const wake = (direct = false) => {
      if (!doorbellArmed || doorbellEpoch !== token || woke) return;
      woke = true;
      clearDoorbellWatchdog();
      doorbellArmed = false;
      doorbellEpoch = (doorbellEpoch + 1) | 0;
      setCompletionWaiterArmed(false);
      if (direct) {
        // A native arm that observes an already-published completion has no
        // callback to wait for. Drain it now: routing this known result back
        // through setImmediate recreates the very millisecond-sized hop that
        // the native doorbell exists to remove.
        check.isRunning = true;
        check();
        return;
      }
      // Keep the existing macrotask boundary. Calling check directly from a
      // resolved waitAsync promise can chain microtasks under a hot workload
      // and starve host I/O.
      notify();
    };

    let supported = false;
    if (
      nativeCompletionDoorbell === true ||
      processCompletionDoorbell === true
    ) {
      // A native arm reports two different things and they must not be
      // conflated: `false` means a completion was already published so the arm
      // deliberately did not ring, which is a normal hot-path outcome. Only a
      // throw means the transport is unusable. Treating the race as
      // "unsupported" disabled the doorbell permanently on its second arm.
      let armed = false;
      let usable = true;
      try {
        armed = armCompletionNotifier();
      } catch {
        usable = false;
      }
      supported = usable;
      // The arm itself drains the completion it just observed.
      if (usable && !armed) wake(true);
      else if (usable) {
        // A waitAsync arm carries its own timeout; a ring does not, so one that
        // never arrives would park the host for good. Bun on Windows can leave
        // a child's process.send unwritten, and every call behind it hung.
        // Unref'd: live workers keep the host up, and a pool that has shut
        // down must not wait out the timer.
        doorbellWatchdog = setTimeout(() => wake(), DOORBELL_WATCHDOG_MS);
        if (typeof doorbellWatchdog === "number") {
          (globalThis as { Deno?: { unrefTimer?: (id: number) => void } }).Deno
            ?.unrefTimer?.(doorbellWatchdog);
        } else {
          (doorbellWatchdog as { unref?: () => void }).unref?.();
        }
      }
    } else {
      try {
        supported = waitForCompletion(wake, DOORBELL_WATCHDOG_MS);
      } catch {
        supported = false;
      }
    }

    // Some runtimes reject waitAsync on their SharedArrayBuffer variants; fall
    // back to polling rather than hanging the pool.
    if (!supported) {
      doorbellEnabled = false;
      // The window was narrowed for a doorbell that no longer exists; widen it
      // back or the ladder fires after a single fruitless drain.
      if (requestedStallFreeLoops === undefined) {
        stallFreeLoops = POLL_STALL_FREE_LOOPS;
      }
      doorbellArmed = false;
      doorbellEpoch = (doorbellEpoch + 1) | 0;
      setCompletionWaiterArmed(false);
      if (
        nativeCompletionDoorbell !== true &&
        processCompletionDoorbell !== true
      ) notify();
    }
  };

  const check = () => {
    if (inFlight) {
      // Another check() is already mid-drain; mark that a re-run is needed
      // so the active invocation loops again before yielding.
      check.rerun = true;
      return;
    }

    // A waitAsync cannot be cancelled, so bumping its epoch makes the eventual
    // callback inert instead.
    cancelDoorbell();

    // Avoid waking an idle lane.
    if (txIdle()) {
      check.isRunning = false;
      return;
    }

    inFlight = true;

    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer);
      backoffTimer = undefined;
    }

    do {
      check.rerun = false;

      txStatus[0] = 1;

      // Wake a parked worker whenever its receive status is clear, so it is
      // up by the time the frames land. Pending frames are not a reliable gate
      // because the queue may have room.
      if (a_load(rxStatus, 0) === 0) wakeLane();

      // Only completed frames count as progress for backoff purposes.
      let completed = false;
      let progressed = true;
      while (progressed) {
        progressed = false;
        if (completeFrame() > 0) {
          progressed = true;
          completed = true;
        }
        while (hasPendingFrames()) {
          if (!flushToWorker()) break;
          progressed = true;
        }
      }

      // The ring above was decided before the frames flushed here existed, and
      // calls publish straight from enqueue without passing through this loop.
      // A worker that parked in between saw neither the frames nor a ring and
      // slept out its whole parkMs. Publishing ends in a seq-cst store and the
      // worker re-checks after clearing rxStatus, so re-reading rxStatus after
      // the pass means either the worker sees the frames or this sees it parked.
      wakeIfParked();

      txStatus[0] = 0;

      if (!txIdle()) {
        // Queued frames indicate back-pressure, not progress; only a completion
        // frees a request slot.
        if (completed) {
          stallCount = 0 | 0;
        } else {
          stallCount = (stallCount + 1) | 0;
        }
        inFlight = false;
        scheduleNotify();
        return;
      }

      // Queue is fully drained.
      stallCount = 0 | 0;
    } while (check.rerun);

    check.isRunning = false;
    inFlight = false;
  };

  check.isRunning = false;
  check.rerun = false;

  /** Enter the drain from a native or IPC completion event. */
  const wakeCompletion = () => {
    if (inFlight || check.isRunning) {
      check.rerun = true;
      return;
    }
    check.isRunning = true;
    check();
  };

  const scheduleNotify = () => {
    if (stallCount <= stallFreeLoops) {
      notify();
      return;
    }

    if (doorbellEnabled) {
      // Release isRunning during the wait so a fresh send() can restart the
      // dispatcher immediately. The epoch in cancelDoorbell() invalidates the
      // old waiter in that case.
      check.isRunning = false;
      armDoorbell();
      return;
    }

    // One delayed wakeup at a time; fresh send() calls preempt via check directly.
    if (backoffTimer !== undefined) return;

    let delay = (stallCount - stallFreeLoops - 1) | 0;
    if (delay < 0) delay = 0;
    else if (delay > MAX_BACKOFF_MS) delay = MAX_BACKOFF_MS;
    // Release isRunning during backoff so pool.ts send() can restart the loop.
    check.isRunning = false;
    backoffTimer = setTimeout(() => {
      backoffTimer = undefined;
      if (!check.isRunning) {
        check.isRunning = true;
        check();
      }
    }, delay);
  };

  return { check, wakeCompletion };
};

type CheckWithState = (() => void) & {
  isRunning: boolean;
  rerun: boolean;
};

export type DispatcherCheck = CheckWithState;

export type ChannelHandlerPump = "auto" | "channel";

export class ChannelHandler {
  // Set only when the pump is a MessageChannel. The `setImmediate` pump has no
  // ports, and nothing outside this class reads them.
  public channel: RuntimeMessageChannelLike | undefined;
  public port1: RuntimeMessagePortLike | undefined;
  public port2: RuntimeMessagePortLike | undefined;

  #handler: (() => void) | undefined;
  readonly #notify: () => void;
  #pending = false;
  readonly #run = () => {
    // Clear before draining so a busy lane can request the next turn.
    this.#pending = false;
    this.#handler?.();
  };

  constructor(pump: ChannelHandlerPump = "auto") {
    if (pump === "auto" && IMMEDIATE_PUMP !== undefined) {
      const immediate = IMMEDIATE_PUMP;
      const run = this.#run;
      this.#notify = () => {
        immediate(run);
      };
      return;
    }

    const channel = createRuntimeMessageChannel();
    const port2 = channel.port2;
    this.channel = channel;
    this.port1 = channel.port1;
    this.port2 = port2;
    this.#notify = () => {
      port2.postMessage(null);
    };
  }

  public notify(): void {
    // Coalesce notifications into one pending drain.
    if (this.#pending) return;
    this.#pending = true;
    this.#notify();
  }

  /** Register the pump handler and start channel ports when present. */
  public open(f: () => void): void {
    this.#handler = f;
    const port1 = this.port1 as unknown as {
      on?: (event: string, handler: () => void) => void;
      onmessage?: ((event: unknown) => void) | null;
      start?: () => void;
    } | undefined;
    if (port1 === undefined) return;
    if (typeof port1.on === "function") {
      port1.on("message", this.#run);
    } else {
      // @ts-ignore
      port1.onmessage = this.#run;
    }
    this.port1?.start?.();
    this.port2?.start?.();
  }

  /**
   * Detaches the handler, and closes the channel if this pump has one.
   */
  public close(): void {
    this.#handler = undefined;
    if (this.port1 === undefined || this.port2 === undefined) return;
    //@ts-ignore
    this.port1.onmessage = null;
    //@ts-ignore
    this.port2.onmessage = null;
    this.port1.close?.();
    this.port2.close?.();
  }
}
