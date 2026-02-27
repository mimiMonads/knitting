export type PromiseWithMaybeReject<T> = Promise<T> & {
  reject?: (reason?: unknown) => void;
};

export type Deferred<T> = {
  promise: PromiseWithMaybeReject<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseWithResolversCtor = PromiseConstructor & {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};

export const withResolvers = <T = unknown>(): Deferred<T> => {
  const native = (Promise as PromiseWithResolversCtor).withResolvers;
  if (typeof native === "function") {
    return native.call(Promise) as Deferred<T>;
  }

  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};
