import type { MultiQueue } from "./mainQueueManager.ts";
import type { MainSignal } from "./signals.ts";
import { signalDebuggerV2 } from "./utils.ts";

export const taskScheduler = ({
  signalBox: {
    currentSignal,
    readyToRead,
    hasNoMoreMessages,
    status,
  },
  queue: {
    resolveTask,
    canWrite,
    dispatchToWorker,
    resolveError,
  },
  channelHandler,
  debugSignal,
  thread,
  perf,
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
  debugSignal?: boolean;
  thread: number;
  perf?: number;
}) => {
  const getSignal = debugSignal === true
    ? signalDebuggerV2({
      isMain: true,
      thread,
      status,
      perf,
    })
    : currentSignal;
  const loop = ((n) => () => ++n % 2 === 1 ? true : false)(0);

  const check = () => {
    switch (getSignal()) {
      case 0:
        resolveTask();
        readyToRead();
        if (loop()) {
          queueMicrotask(check);
          return;
        }
        channelHandler.scheduleCheck();
        return;
      case 1:
        resolveTask();
        readyToRead();
        if (loop()) {
          queueMicrotask(check);
          return;
        }
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
          if (loop()) {
            queueMicrotask(check);
            return;
          }
          readyToRead();
          channelHandler.scheduleCheck();
        }
        return;
      case 100: {
        // Error was thrown in the worker queue
        resolveError();
        readyToRead();
        if (loop()) {
          queueMicrotask(check);
          return;
        } else {
          channelHandler.scheduleCheck();
        }
        return;
      }
      case 126: {
        queueMicrotask(check);
        return;
      }
      case 127:
      case 128: {
        if (loop()) {
          queueMicrotask(check);
          return;
        }
        channelHandler.scheduleCheck();
        return;
      }
      case 192:
        channelHandler.scheduleCheck();
        return;
    }
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

  public scheduleCheck(): void {
    this.channel.port2.postMessage(null);
  }

  /**
   * Opens the channel (if not already open) and sets the onmessage handler.
   * This is the setup so `scheduleCheck` can send a message to the port 1.
   */
  public open(f: () => void): void {
    this.channel.port1.onmessage = f;
    this.channel.port2.start();
    this.channel.port1.start();
  }

  /**
   * Closes the channel if it is open.
   */
  public close(): void {
    this.channel.port1.onmessage = null;
    this.channel.port2.onmessage = null;
    this.channel.port1.close();
    this.channel.port2.close();
  }
}
