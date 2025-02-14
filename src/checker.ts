import type { MultiQueue } from "./mainQueue.ts";
import type { MainSignal } from "./signal.ts";

export const checker = ({
  signalBox: {
    updateLastSignal,
    readyToRead,
    hasNoMoreMessages,
  },
  queue: {
    solve,
    canWrite,
    sendNextToWorker,
  },
  channelHandler,
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
}) => {
  const check = () => {
    if (check.running === false) {
      return;
    }

    switch (updateLastSignal()) {
      case 0:
        solve();
        if (canWrite()) {
          sendNextToWorker();
        } else {
          readyToRead();
        }
        queueMicrotask(check);
        return;

      case 1:
        readyToRead();
        queueMicrotask(check);
        return;

      case 2:
        if (canWrite()) {
          sendNextToWorker();
          queueMicrotask(check);
        } else {
          hasNoMoreMessages();
          check.running = false;
        }
        return;

      case 3:
        if (canWrite()) {
          sendNextToWorker();
          queueMicrotask(check);
          console.log(updateLastSignal());
        } else {
          readyToRead();
        }
        return;

      case 127: {
        channelHandler.scheduleCheck();
        return;
      }
      case 192:
      case 224:
        queueMicrotask(check);
        return;

      case 254:
        sendNextToWorker();
        queueMicrotask(check);
        return;

      case 255:
        check.running = false;
        return;
    }

    console.log(updateLastSignal());
    throw new Error("unreachable");
  };

  // This is not the best way to do it but it should work for now
  check.running = false;

  return check;
};

export class ChannelHandler {
  public channel: MessageChannel;
  private isOpen: boolean;

  constructor() {
    this.channel = new MessageChannel();
    this.isOpen = false;
  }

  public scheduleCheck(): void {
    this.channel.port2.postMessage(null);
  }

  /**
   * Opens the channel (if not already open) and sets the onmessage handler.
   * This is the setup so `scheduleCheck` can send a message to the port 1.
   */
  public open(f: () => void): void {
    if (this.isOpen) {
      return;
    }
    this.channel.port1.onmessage = f;
    this.channel.port2.start();
    this.channel.port1.start();
    this.isOpen = true;
  }

  /**
   * Closes the channel if it is open.
   */
  public close(): void {
    if (!this.isOpen) {
      return;
    }
    this.channel.port1.close();
    this.channel.port1.onmessage = null;
    this.channel.port2.close();
    this.isOpen = false;
  }
}
