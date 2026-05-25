export type PromiseWithMaybeReject<T> = Promise<T> & {
    reject: (reason?: unknown) => void;
};
export type Deferred<T> = {
    promise: PromiseWithMaybeReject<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};
export declare const withResolvers: <T = unknown>() => Deferred<T>;
