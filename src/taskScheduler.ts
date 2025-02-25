import type { MultiQueue } from "./mainQueueManager.ts";
import type { MainSignal } from "./signals.ts";

export const taskScheduler = ({
  signalBox: {
    updateLastSignal,
    readyToRead,
    hasNoMoreMessages,
  },
  queue: {
    resolveTask,
    canWrite,
    dispatchToWorker,
  },
  channelHandler,
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
}) => {


  const check = () => {


    switch (updateLastSignal()) {
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
        channelHandler.scheduleCheck();
        return;
      }
      case 192:
      case 224:
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

/**
 * @pure
 */
const debugThisThing = () => {
  const arr: [number, number][] = [];

  return {
    enqueue: (n: number) => {
      if (arr.length === 0) {
        arr.push([
          n,
          performance.now(),
        ]);
      }

      if (n !== arr.at(-1)![0]) {
        arr.push(
          [n, performance.now()],
        );
      }
    },
    log: () => {
      console.log("=======");
      arr.forEach((x) => console.log(x));
    },
  };
};
