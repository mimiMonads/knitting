import { type MultiQueue } from "./tx-queue.ts";
import { type MainSignal } from "../ipc/transport/shared-memory.ts";
import {
  createRuntimeMessageChannel,
  type RuntimeMessageChannelLike,
  type RuntimeMessagePortLike,
} from "../common/worker-runtime.ts";
import type { DispatcherSettings } from "../types.ts";

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
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
  dispatcherOptions?: DispatcherSettings;
}) => {
  const a_load = Atomics.load;
  const a_store = Atomics.store;
  const a_notify = Atomics.notify;
  const notify = channelHandler.notify.bind(channelHandler);
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
        a_notify(opView, 0, 1);
      }

      // Drain loop: local vars so V8 keeps them as unboxed int32.
      let anyProgressed = false;
      let progressed = true;
      while (progressed) {
        progressed = false;
        if (completeFrame() > 0) {
          progressed = true;
          anyProgressed = true;
        }
        while (hasPendingFrames()) {
          if (!flushToWorker()) break;
          progressed = true;
          anyProgressed = true;
        }
      }

      txStatus[0] = 0;

      if (!txIdle()) {
        if (anyProgressed || hasPendingFrames()) {
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

export class ChannelHandler {
  public channel: RuntimeMessageChannelLike;
  public port1: RuntimeMessagePortLike;
  public port2: RuntimeMessagePortLike;
  readonly #post2: (message: unknown) => void;

  constructor() {
    this.channel = createRuntimeMessageChannel();
    this.port1 = this.channel.port1;
    this.port2 = this.channel.port2;
    this.#post2 = this.port2.postMessage.bind(this.port2);
  }

  public notify(): void {
    this.#post2(null);
  }

  /**
   * Opens the channel (if not already open) and sets the onmessage handler.
   * This is the setup so `notify` can send a message to the port 1.
   */
  public open(f: () => void): void {
    const port1 = this.port1 as unknown as {
      on?: (event: string, handler: () => void) => void;
      onmessage?: ((event: unknown) => void) | null;
      start?: () => void;
    };
    if (typeof port1.on === "function") {
      port1.on("message", f);
    } else {
      // @ts-ignore
      port1.onmessage = f;
    }
    this.port1.start?.();
    this.port2.start?.();
  }

  /**
   * Closes the channel if it is open.
   */
  public close(): void {
    //@ts-ignore
    this.port1.onmessage = null;
    //@ts-ignore
    this.port2.onmessage = null;
    this.port1.close?.();
    this.port2.close?.();
  }
}
