import type { MultiQueue } from "./mainQueue.ts";
import type { MainSignal } from "./signal.ts";

export const checker = ({
  signalBox,
  queue,
  channelHandler
}: {
  queue: MultiQueue;
  signalBox: MainSignal;
  channelHandler: ChannelHandler
}) => {
  const  check =  () => {

    if(check.running === false) {
      return
    }

    switch (signalBox.updateLastSignal()) {
      case 0:
        queue.solve();
        if (queue.canWrite()) {
          queue.sendNextToWorker();
        } else {
          signalBox.readyToRead();
        }
        queueMicrotask(check);
        return;

      case 1:
        signalBox.readyToRead();
        queueMicrotask(check);
        return;

      case 2:
        if (queue.canWrite()) {
          queue.sendNextToWorker();
          queueMicrotask(check);
        } else {
          signalBox.hasNoMoreMessages();
          check.running = false;
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
      
        queue.sendNextToWorker();
        queueMicrotask(check);
        return;

      case 255:
        check.running = false;
        return;
    }

    console.log(signalBox.updateLastSignal());
    throw new Error("unreachable");
  }

  // This is not the best way to do it but it should work for now 
  check.running = false;


 return check
};

export class ChannelHandler {
  public channel: MessageChannel;
  private isOpen: boolean;

  constructor() {
    this.channel = new MessageChannel();
    this.isOpen = false;
  }


  public scheduleCheck(): void {
    this.channel.port2.postMessage(null)
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


