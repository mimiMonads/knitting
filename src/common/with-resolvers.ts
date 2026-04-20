export type PromiseWithMaybeReject<T> = Promise<T> & {
  reject: (reason?: unknown) => void;
};

export type Deferred<T> = {
  promise: PromiseWithMaybeReject<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseWithResolversCtor = PromiseConstructor & {
  withResolvers?: <T>() => PromiseResolvers<T>;
};

const attachReject = <T>(
  promise: Promise<T>,
  reject: (reason?: unknown) => void,
): PromiseWithMaybeReject<T> => {
  const deferredPromise = promise as PromiseWithMaybeReject<T>;
  deferredPromise.reject = reject;
  return deferredPromise;
};

export const withResolvers = <T = unknown>(): Deferred<T> => {
  const native = (Promise as PromiseWithResolversCtor).withResolvers;
  if (typeof native === "function") {
    const deferred = native.call(Promise) as PromiseResolvers<T>;
    return {
      promise: attachReject(deferred.promise, deferred.reject),
      resolve: deferred.resolve,
      reject: deferred.reject,
    };
  }

  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = attachReject(new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  }), reject);

  return { promise, resolve, reject };
};
