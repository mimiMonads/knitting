import type { MultiQueue } from "./mainQueueManager.ts";
import { type MainSignal, SignalStatus } from "./signals.ts";
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
    switch (status[0]) {
      case SignalStatus.WorkerWaiting:
        resolveTask();
        readyToRead();
        if (loop()) {
          queueMicrotask(check);
          return;
        }
        channelHandler.scheduleCheck();
        return;
      case SignalStatus.MessageRead:
        resolveTask();
        readyToRead();
        if (loop()) {
          queueMicrotask(check);
          return;
        }
        channelHandler.scheduleCheck();
        return;

      case SignalStatus.AllTasksDone:
        if (canWrite()) {
          dispatchToWorker();
          queueMicrotask(check);
        } else {
          hasNoMoreMessages();
          check.isRunning = false;
        }
        return;

      case SignalStatus.WaitingForMore:
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
      case SignalStatus.ErrorThrown: {
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
      case SignalStatus.Promify:
      case SignalStatus.MainReadyToRead: {
        if (loop()) {
          queueMicrotask(check);
          return;
        }
        channelHandler.scheduleCheck();
        return;
      }
      case SignalStatus.MainSend:
        if (loop()) {
          queueMicrotask(check);
          return;
        }
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
