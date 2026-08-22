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
 * The macrotask primitive the host pump hops through.
 *
 * `check` re-arms the pump after every drain that leaves work outstanding, so
 * this is the hottest path on the host thread: profiling a heterogeneous pool
 * put it at roughly a third of host CPU, at ~70 hops per completion. Which
 * primitive is cheapest is not the same on every runtime (ns per round trip,
 * 200k hops, median of three):
 *
 *   runtime   MessageChannel   setImmediate
 *   bun              757            810
 *   node            1625           1326
 *   deno            4662           1110
 *
 * so pick per runtime rather than making every host pay Deno's 4x. Bun keeps
 * the channel; runtimes without `setImmediate` (browser, Andromeda) have no
 * choice to make.
 *
 * Cheaper per hop is not the same as better, and what decides it is the
 * dispatcher topology, not the runtime. Measured on Deno, 8 workers,
 * heterogeneous fanout, channel pump -> immediate pump:
 *
 *   per-thread      9.6k -> 9.8k rps, p99 10.0 -> 10.0ms, host CPU 0.90 -> 0.77
 *   serial-channel  9.0k -> 7.0k rps, p99 11.5 -> 30.9ms, host CPU 0.96 -> 0.75
 *
 * One `serial-channel` hop drives every lane's check in turn and depends on the
 * channel's delivery to do it; a pump that is only cheaper starves it. So
 * `serial-channel` asks for the channel explicitly and every other topology
 * takes the cheap pump.
 */
const IMMEDIATE_PUMP = RUNTIME === "deno" || RUNTIME === "node"
  ? SET_IMMEDIATE
  : undefined;

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
  },
  channelHandler,
  dispatcherOptions,
  notifySignal,
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
  dispatcherOptions?: DispatcherSettings;
  notifySignal?: () => void;
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
  let stallCount = 0 | 0;
  const STALL_FREE_LOOPS = Math.max(
    0,
    (dispatcherOptions?.stallFreeLoops ?? 128) | 0,
  );
  const MAX_BACKOFF_MS = Math.max(
    0,
    (dispatcherOptions?.maxBackoffMs ?? 10) | 0,
  );
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  // inFlight prevents re-entrancy when pool.ts fires check() concurrently
  // from both send() and the channel callback. Cheaper than try/finally.
  let inFlight = false;

  const check = () => {
    if (inFlight) {
      // Another check() is already mid-drain; mark that a re-run is needed
      // so the active invocation loops again before yielding.
      check.rerun = true;
      return;
    }

    // Nothing enqueued and nothing outstanding at the worker: skip the drain.
    // Without this an idle lane still pays a txStatus write, an rxStatus load
    // and — worst of all — an Atomics.notify that wakes a parked worker for no
    // reason. Under the serial-channel dispatcher every lane is checked on
    // every tick, so that waste is what makes latency grow with thread count.
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

      // Wake the worker before draining so it can start processing while we flush.
      if (a_load(rxStatus, 0) === 0) {
        a_store(opView, 0, 1);
        wakeSignal();
      }

      // Drain loop: local vars so V8 keeps them as unboxed int32.
      //
      // `completed` feeds `stallCount`, which asks whether the pump is still
      // earning its keep. The pump exists to reap completions a worker has no
      // way to announce, so only a reaped completion counts as progress here.
      // Handing work *to* a worker must not: `send()` drives `check` directly,
      // so a host busy submitting keeps the loop hot without the counter's
      // help, and letting a flush reset the counter would leave the backoff
      // unreachable for a pool that never runs dry.
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
        if (completed || hasPendingFrames()) {
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

  const scheduleNotify = () => {
    if (stallCount <= STALL_FREE_LOOPS) {
      notify();
      return;
    }

    // One delayed wakeup at a time; fresh send() calls preempt via check directly.
    if (backoffTimer !== undefined) return;

    let delay = (stallCount - STALL_FREE_LOOPS - 1) | 0;
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

  return { check };
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
      // One closure allocated once: the pump fires hundreds of thousands of
      // times a second under load. Going through `#handler` also leaves a
      // callback that outlives `close()` inert.
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
