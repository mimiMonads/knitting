const attachReject = (promise, reject) => {
    const deferredPromise = promise;
    deferredPromise.reject = reject;
    return deferredPromise;
};
export const withResolvers = () => {
    const native = Promise.withResolvers;
    if (typeof native === "function") {
        const deferred = native.call(Promise);
        return {
            promise: attachReject(deferred.promise, deferred.reject),
            resolve: deferred.resolve,
            reject: deferred.reject,
        };
    }
    let resolve;
    let reject;
    const promise = attachReject(new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    }), reject);
    return { promise, resolve, reject };
};
