import type { MultiQueue } from "./mainQueueManager.ts";
import type { MainSignal } from "./signals.ts";
import { signalDebugger } from "./utils.ts";

export const taskScheduler = ({
  signalBox: {
    currentSignal,
    readyToRead,
    hasNoMoreMessages,
  },
  queue: {
    resolveTask,
    canWrite,
    dispatchToWorker,
  },
  channelHandler,
  debugSignal,
  thread,
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
  debugSignal?: boolean;
  thread: number;
}) => {
  const getSignal = debugSignal === true
    ? signalDebugger({
      isMain: true,
      thread,
      currentSignal,
    })
    : currentSignal;
  const check = () => {
    switch (getSignal()) {
      case 0:
        resolveTask();
        readyToRead();
        channelHandler.scheduleCheck();
        return;

      case 2:
        if (canWrite()) {
          dispatchToWorker();
          queueMicrotask(check);
        } else {
          hasNoMoreMessages();
          check.isRunning = false;
        }
        return;

      case 3:
        if (canWrite()) {
          dispatchToWorker();
          queueMicrotask(check);
        } else {
          readyToRead();
          channelHandler.scheduleCheck();
        }
        return;

      case 127: {
        //queueMicrotask(check);
        channelHandler.scheduleCheck();
        return;
      }
      case 192:
        queueMicrotask(check);
        return;

      case 254:
        dispatchToWorker();
        queueMicrotask(check);
        return;

      case 255:
        check.isRunning = false;
        return;
    }
  };

  // This is not the best way to do it but it should work for now
  check.isRunning = false;

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
    this.channel.port2.onmessage = null;
    this.isOpen = false;
  }
}
