import { type MultiQueue } from "./tx-queue.ts";
import { type MainSignal, OP } from "../ipc/transport/shared-memory.ts";
import { MessageChannel } from "node:worker_threads";
import { WorkerSettings } from "../types.ts";

export const hostDispatcherLoop = ({
  signalBox: {
    opView,
    op,
    txStatus,
    rxStatus,
  },
  queue: {
    completeFrame,
    hasPendingFrames,
    flushToWorker,
    rejectFrame,
    completeImmediate,
  },
  channelHandler,
  workerOptions,
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler;
  totalNumberOfThread: number;
  workerOptions?: WorkerSettings;
}) => {
  let catchEarly = true;
  const nextTick = process.nextTick;
  const check = () => {
    switch (op[0]) {
      case OP.FastResolve: {
        completeImmediate();
        op[0] = OP.AllTasksDone;
        queueMicrotask(check);
        return;
      }
      case OP.WorkerWaiting:
        txStatus[0] = 1;

        if (rxStatus[0] === 1) {
          Atomics.notify(opView, 0, 1);
          completeFrame();
          queueMicrotask(check);
          return;
        }

        do {
          completeFrame();
        } while (op[0] === OP.WorkerWaiting);

        txStatus[0] = 0;

        queueMicrotask(check);
        return;
      case OP.AllTasksDone:
        if (hasPendingFrames()) {
          Atomics.notify(opView, 0, 1);
          flushToWorker();
          queueMicrotask(check);
        } else {
          txStatus[0] = 0;
          op[0] = OP.MainStop;
          check.isRunning = false;
          catchEarly = true;
        }
        return;

      case OP.WaitingForMore:
        if (hasPendingFrames()) {
          flushToWorker();

          nextTick(check);
        } else {
          if (catchEarly === true) {
            catchEarly = false;
            queueMicrotask(check);
            return;
          }
          op[0] = OP.MainReadyToRead;
          channelHandler.notify();
        }
        return;
      case OP.ErrorThrown: {
        // Error was thrown in the worker queue
        rejectFrame();
        op[0] = OP.MainReadyToRead;
        if (catchEarly === true) {
          catchEarly = false;
          queueMicrotask(check);
          return;
        }

        channelHandler.notify();

        return;
      }

      case OP.HighPriorityResolve:
      case OP.MainReadyToRead: {
        if (catchEarly === true) {
          catchEarly = false;
          queueMicrotask(check);
          return;
        }
        channelHandler.notify();
        return;
      }
      case OP.MainSend:
        nextTick(check);
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
