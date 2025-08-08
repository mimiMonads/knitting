import type { MultiQueue } from "./mainQueueManager.ts";
import { type MainSignal, SignalStatus } from "./signals.ts";

export const taskScheduler = ({
  signalBox: {
    status,
  },
  queue: {
    resolveTask,
    isThereAnythingToBeSent,
    dispatchToWorker,
    resolveError,
    fastResolveTask,
  },
  channelHandler,
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
}) => {
  let catchEarly = true;
  const check = () => {
    switch (status[0]) {
      case SignalStatus.FastResolve: {
        fastResolveTask();
        status[0] = SignalStatus.AllTasksDone;
        queueMicrotask(check);
        return;
      }
      case SignalStatus.WorkerWaiting:
        do {
          resolveTask();
        } while (status[0] === SignalStatus.WorkerWaiting);

        queueMicrotask(check);
        return;
      case SignalStatus.AllTasksDone:
        if (isThereAnythingToBeSent()) {
          dispatchToWorker();
          queueMicrotask(check);
        } else {
          status[0] = SignalStatus.MainStop;
          check.isRunning = false;
          catchEarly = true;
        }
        return;

      case SignalStatus.WaitingForMore:
        if (isThereAnythingToBeSent()) {
        
          dispatchToWorker();
      

          queueMicrotask(check);
        } else {
          if (catchEarly === true) {
            catchEarly = false;
            queueMicrotask(check);
            return;
          }
          status[0] = SignalStatus.MainReadyToRead;
          channelHandler.scheduleCheck();
        }
        return;
      case SignalStatus.ErrorThrown: {
        // Error was thrown in the worker queue
        resolveError();
        status[0] = SignalStatus.MainReadyToRead;
        if (catchEarly === true) {
          catchEarly = false;
          queueMicrotask(check);
          return;
        }

        channelHandler.scheduleCheck();

        return;
      }

      case SignalStatus.HighPriorityResolve:
      case SignalStatus.MainReadyToRead: {
        if (catchEarly === true) {
          catchEarly = false;
          queueMicrotask(check);
          return;
        }
        channelHandler.scheduleCheck();
        return;
      }
      case SignalStatus.MainSend:
        queueMicrotask(check);
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
