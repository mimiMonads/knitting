import { type MultiQueue } from "./tx-queue.ts";
import { type MainSignal } from "../ipc/transport/shared-memory.ts";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { DispatcherSettings } from "../types.ts";
import { IS_BUN, IS_DENO, SET_IMMEDIATE } from "../common/runtime.ts";

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
  let stallCount = 0;
  const STALL_FREE_LOOPS = dispatcherOptions?.stallFreeLoops ?? 128;
  const MAX_BACKOFF_MS = dispatcherOptions?.maxBackoffMs ?? 10;

  const check = () => {
    
    // THIS IS JUST A HINT
    txStatus[0] = 1
    let progressed = false;
    let anyProgressed = false;

    if (a_load(rxStatus, 0) === 0 && hasPendingFrames() ) {
      
      a_store(opView, 0, 1);
      a_notify(opView, 0, 1);
      do{
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

    }while(progressed)
    }

    do{
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

        
    }while(progressed)


    if (!txIdle()) {
      if (anyProgressed || hasPendingFrames()) {
        stallCount = 0;
      } else {
        stallCount++;
      }
      scheduleNotify();
      return;
    }

    // THIS IS JUST A HINT
    txStatus[0] = 0
    //Atomics.store(txStatus, 0, 0);
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
    //@ts-ignore
    this.port1.onmessage = f;
    this.port2.start();
    this.port1.start();
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
