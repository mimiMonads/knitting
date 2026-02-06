import { type MultiQueue } from "./tx-queue.ts";
import { type MainSignal } from "../ipc/transport/shared-memory.ts";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { DispatcherSettings } from "../types.ts";

enum Comment {
  thisIsAHint = 0,
}

export const hostDispatcherLoop = ({
  signalBox: {
    opView,
    txStatus,
    rxStatus,
  },
  queue: {
    completeFrame,
    completeFrameOne,
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
  let stallCount = 0;
  const STALL_FREE_LOOPS = dispatcherOptions?.stallFreeLoops ?? 128;
  const MAX_BACKOFF_MS = dispatcherOptions?.maxBackoffMs ?? 10;

  let progressed = false;
  let anyProgressed = false;
  let mask = 0
  const resolveOne = completeFrameOne ?? completeFrame;

      const runDrainLoop = () => {
      do {
        progressed = false;
        if ((completeFrame() ?? 0) > 0) {
          progressed = true;
          anyProgressed = true;
        }

        while (hasPendingFrames()) {
          if (!flushToWorker()) break;
          progressed = true;
          anyProgressed = true;
        }
      } while (progressed);
    };

          const runDrainSlowLoop = () => {
      do {
        progressed = false;
        if ((resolveOne() ?? 0) > 0) {
          progressed = true;
          anyProgressed = true;
        }
      } while (progressed);
    }

    const wakeWorker = () => {
      a_store(opView, 0, 1);
      a_notify(opView, 0, 1);
    };

 

  const check = () => {
    

    txStatus[Comment.thisIsAHint] = 1;
    mask = 0;
    mask += hasPendingFrames() ? 1 : 0;
    mask += completeFrameOne() > 0 ? 2 : 0;
    mask += a_load(rxStatus, 0) === 0 ? 4 : 0;

    switch (mask) {
      case 0:
        break;
      case 1:
        runDrainLoop();
        break;
      case 2:
        runDrainSlowLoop()
        break;
      case 3:
        runDrainLoop();
        break;
      case 4:
        break;
      case 5:
        wakeWorker();
        runDrainLoop();
        break;
      case 6:
        wakeWorker();
        runDrainSlowLoop()
        break;
      case 7:
        wakeWorker();
        runDrainLoop();
        break;
      default:
        break;
    }


    txStatus[Comment.thisIsAHint] = 0;
    if (!txIdle()) {

      if (anyProgressed) {
        stallCount = 0;
      } else {
        stallCount++;
      }
      scheduleNotify();
      return;
    }

    // Best-effort hint only; non-atomic by design.
    txStatus[Comment.thisIsAHint] = 0;
    check.isRunning = false;
    stallCount = 0;
  };

  // This is not the best way to do it but it should work for now
  check.isRunning = false;

  const scheduleNotify = () => {
    if (stallCount <= STALL_FREE_LOOPS) {
      notify();
      return;
    }



      setTimeout(check, Math.min(
      MAX_BACKOFF_MS,
      Math.max(0, stallCount - STALL_FREE_LOOPS - 1),
    ));
   
  };

  return check;
};

export class ChannelHandler {
  public channel: MessageChannel;
  public port1: MessagePort;
  public port2: MessagePort;
  readonly #post2: (message: unknown) => void;

  constructor() {
    this.channel = new MessageChannel();
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
    this.port1.close();
    this.port2.close();
  }
}
