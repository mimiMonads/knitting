import { type MultiQueue } from "./tx-queue.ts";
import { type MainSignal } from "../ipc/transport/shared-memory.ts";
import { MessageChannel } from "node:worker_threads";

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
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
  }) => {
  const check = () => {
    
    // THIS IS JUST A HINT
    txStatus[0] = 1
    //Atomics.store(txStatus, 0, 1);
    let progressed = false;

    const resolved = completeFrame() as number | undefined;
    if ((resolved ?? 0) > 0) progressed = true;

    while (hasPendingFrames()) {
      if (!flushToWorker()) break;
      progressed = true;
    }

    if (hasPendingFrames() && Atomics.load(rxStatus, 0) === 0) {
      Atomics.notify(opView, 0, 1);
    }

    if (progressed) {
      Promise.resolve().then(check);
      return;
    }

    if (!txIdle()) {
      channelHandler.notify();
      return;
    }

    // THIS IS JUST A HINT
    txStatus[0] = 0
    //Atomics.store(txStatus, 0, 0);
    check.isRunning = false;
  };

  // This is not the best way to do it but it should work for now
  check.isRunning = false;

  return check;
};

export class ChannelHandler {
  public channel: MessageChannel;

  constructor() {
    this.channel = new MessageChannel();
  }

  public notify(): void {
    this.channel.port2.postMessage(null);
  }

  /**
   * Opens the channel (if not already open) and sets the onmessage handler.
   * This is the setup so `notify` can send a message to the port 1.
   */
  public open(f: () => void): void {
    //@ts-ignore
    this.channel.port1.onmessage = f;
    this.channel.port2.start();
    this.channel.port1.start();
  }

  /**
   * Closes the channel if it is open.
   */
  public close(): void {
    //@ts-ignore
    this.channel.port1.onmessage = null;
    //@ts-ignore
    this.channel.port2.onmessage = null;
    this.channel.port1.close();
    this.channel.port2.close();
  }
}
