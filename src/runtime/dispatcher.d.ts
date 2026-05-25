import { type MultiQueue } from "./tx-queue.js";
import { type MainSignal } from "../ipc/transport/shared-memory.js";
import { type RuntimeMessageChannelLike, type RuntimeMessagePortLike } from "../common/worker-runtime.js";
import type { DispatcherSettings } from "../types.js";
export declare const hostDispatcherLoop: ({ signalBox: { opView, txStatus, rxStatus, }, queue: { completeFrame, hasPendingFrames, flushToWorker, txIdle, }, channelHandler, dispatcherOptions, notifySignal, }: {
    queue: MultiQueue;
    signalBox: MainSignal;
    channelHandler: ChannelHandler;
    dispatcherOptions?: DispatcherSettings;
    notifySignal?: () => void;
}) => {
    check: {
        (): void;
        isRunning: boolean;
        rerun: boolean;
    };
};
export declare class ChannelHandler {
    #private;
    channel: RuntimeMessageChannelLike;
    port1: RuntimeMessagePortLike;
    port2: RuntimeMessagePortLike;
    constructor();
    notify(): void;
    /**
     * Opens the channel (if not already open) and sets the onmessage handler.
     * This is the setup so `notify` can send a message to the port 1.
     */
    open(f: () => void): void;
    /**
     * Closes the channel if it is open.
     */
    close(): void;
}
