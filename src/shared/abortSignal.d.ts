import { withResolvers } from "../common/with-resolvers.js";
import { type SharedBufferSource } from "../common/shared-buffer-region.js";
export declare const AbortSignalPoolExhausted: unique symbol;
export declare const EnqueuedAbortSignal: unique symbol;
export type SignalAbortStore = ReturnType<typeof signalAbortFactory>;
export type SetSignalResult = -1 | 0 | 1;
export declare const signalAbortFactory: ({ sab, maxSignals, }: {
    sab: SharedBufferSource;
    maxSignals?: number;
}) => {
    max: number;
    closeNow: number;
    getSignal: () => number;
    setSignal: (signal: number) => SetSignalResult;
    abortAll: () => number;
    hasAborted: (signal: number) => boolean;
    resetSignal: (signal: number) => boolean;
    inUseCount: () => number;
};
export declare class OneShotDeferred<T> {
    #private;
    constructor(deferred: ReturnType<typeof withResolvers<T>>, onSettle: () => void);
}
