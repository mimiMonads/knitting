import { type MultiQueue } from "./tx-queue.ts";
import { type MainSignal } from "../ipc/transport/shared-memory.ts";
import {
  createRuntimeMessageChannel,
  type RuntimeMessageChannelLike,
  type RuntimeMessagePortLike,
} from "../common/worker-runtime.ts";
import { RUNTIME, SET_IMMEDIATE } from "../common/runtime.ts";
import type { DispatcherSettings } from "../types.ts";

/**
 * Macrotask primitive for the host pump, picked per runtime: a round trip costs
 * 757ns on Bun via MessageChannel but 4662ns on Deno, where `setImmediate` is
 * 1110ns. Bun keeps the channel; browser and Andromeda have no choice.
 *
 * `serial-channel` opts back into the channel explicitly (see `src/api.ts`): one
 * hop drives every lane's check in turn and relies on the channel's delivery to
 * do it, so a merely cheaper pump starves it -- it cost 25% throughput there.
 */
const IMMEDIATE_PUMP = RUNTIME === "deno" || RUNTIME === "node"
  ? SET_IMMEDIATE
  : undefined;

/**
 * Free drain hops before `scheduleNotify` stops re-arming the pump for free.
 *
 * The window has to match what the dispatcher escalates *to*, so these are
 * chosen together and `canUseDoorbell` picks between them. Polling escalates to
 * the `setTimeout` ladder, whose finest rung is ~1.1ms on every runtime, so it
 * wants a wide window; that sleep is also load-bearing, since it batches
 * completions. A doorbell escalates to `Atomics.waitAsync` at about the price of
 * one hop, so it wants a narrow one.
 *
 * Mixing them is the trap: a doorbell behind the wide window keeps every poll
 * hop *and* adds the arm, and loses to plain polling at every thread count.
 * Measurements behind both values: `docs/host-doorbell-proposal.md`.
 */
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
  crossProcess,
  nativeCompletionDoorbell,
  processCompletionDoorbell,
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
  dispatcherOptions?: DispatcherSettings;
  notifySignal?: () => void;
  /** Workers live in other processes; disables only the atomic doorbell. */
  crossProcess?: boolean;
  /** A runtime-native completion ring that wakes the host event loop. */
  nativeCompletionDoorbell?: boolean;
  /** A process IPC completion doorbell that wakes the host event loop. */
  processCompletionDoorbell?: boolean;
}) => {
  const a_load = Atomics.load;
  const a_store = Atomics.store;
  const a_notify = Atomics.notify;
  const canNotifySignal = opView.buffer instanceof SharedArrayBuffer;
  const wakeSignal = notifySignal ??
    (() => {
      if (canNotifySignal) a_notify(opView, 0, 1);
    });
  const notify = () => channelHandler.notify();
  // `crossProcess` is a capability, not a preference, so it overrides an
  // explicit `doorbell: true`: V8's Atomics waiter list is per isolate, so a
  // worker in another process can never ring the host's waiter, and an armed
  // doorbell would just sleep to the watchdog.
  const canUseAtomicDoorbell = (RUNTIME === "bun" || RUNTIME === "node") &&
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

    // Idle lane: skip the drain. Otherwise it pays a txStatus write, an rxStatus
    // load, and an Atomics.notify that wakes a parked worker for nothing — the
    // waste that makes serial-channel latency grow with thread count.
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

      // Ring on every pass where the worker is parked, not only when the host
      // is back-pressured. `hasPendingFrames()` is true only when the region is
      // full: when it has room `enqueue()` writes straight through and the
      // pending queue stays empty, so gating on it suppressed *every* ring on
      // short tasks and left the worker to find its work by park timeout — up
      // to 17x throughput in both topologies. `send()` cannot cover that: its
      // `laneWake()` sits behind an `isRunning` early return that is always
      // taken under load. The `rxStatus` load is the real gate and costs 8.3ns;
      // a ring that finds no waiter costs 28ns and never cost throughput in any
      // cell measured. See `docs/ring-gate-fails-open.md`.
      if (a_load(rxStatus, 0) === 0) {
        a_store(opView, 0, 1);
        wakeSignal();
      }

      // Local vars so V8 keeps them as unboxed int32. Only a reaped completion
      // counts as progress for `stallCount`: the pump exists to notice work a
      // worker cannot announce, and letting a flush reset the counter would
      // leave the escalation unreachable for a pool that never runs dry.
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

      txStatus[0] = 0;

      if (!txIdle()) {
        // Back-pressure is not progress. Frames still queued here mean the
        // request region is full, and only a completion frees a slot — which
        // is exactly the event the doorbell is armed on, so escalating to it
        // loses nothing. Counting them as progress instead pinned `stallCount`
        // at zero for as long as a caller kept more than `LockBound.slots`
        // calls in flight, so the pump never escalated and spun its macrotask
        // hop for every completion. See `docs/poll-mode-backpressure.md` for
        // what this costs the pump that has no doorbell to escalate to.
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

  /**
   * Enter the drain directly from a real host event source (IPC, a native
   * callback, or a future fd watcher). This intentionally bypasses the
   * MessageChannel/setImmediate pump; `inFlight` retains the old re-entrancy
   * behaviour when an event lands during a drain.
   */
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

  constructor(pump: ChannelHandlerPump = "auto") {
    if (pump === "auto" && IMMEDIATE_PUMP !== undefined) {
      const immediate = IMMEDIATE_PUMP;
      // Allocated once; the pump fires hundreds of thousands of times a second.
      // Routing via `#handler` also makes a callback outliving `close()` inert.
      const run = () => {
        this.#handler?.();
      };
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
    this.#notify();
  }

  /**
   * Registers the handler the pump calls back into. On the channel pump this is
   * also where the ports are opened, so `notify` can reach port 1.
   */
  public open(f: () => void): void {
    this.#handler = f;
    const port1 = this.port1 as unknown as {
      on?: (event: string, handler: () => void) => void;
      onmessage?: ((event: unknown) => void) | null;
      start?: () => void;
    } | undefined;
    if (port1 === undefined) return;
    if (typeof port1.on === "function") {
      port1.on("message", f);
    } else {
      // @ts-ignore
      port1.onmessage = f;
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
