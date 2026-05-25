type PauseOptions = {
    pauseInNanoseconds?: number;
};
export type NativeWaitU32 = (buffer: ArrayBuffer | SharedArrayBuffer, byteOffset: number, expected: number, timeoutMs?: number) => unknown;
export declare const whilePausing: ({ pauseInNanoseconds }: PauseOptions) => () => void;
export declare const pauseGeneric: () => void;
export declare const sleepUntilChanged: ({ at, opView, pauseInNanoseconds, rxStatus, txStatus, enqueueLock, write, nativeWaitU32, useSharedMemoryWait, }: {
    opView: Int32Array;
    rxStatus: Int32Array;
    txStatus: Int32Array;
    pauseInNanoseconds?: number;
    at: number;
    enqueueLock: () => boolean;
    write?: () => number | boolean;
    nativeWaitU32?: NativeWaitU32;
    useSharedMemoryWait?: boolean;
}) => (value: number, spinMicroseconds: number, parkMs?: number) => void;
export {};
