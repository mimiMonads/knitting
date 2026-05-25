import { getTaskFunctionMeta, getTaskSlotMeta, TASK_SLOT_META_VALUE_MASK, } from "../memory/lock.js";
const ABORT_SIGNAL_META_OFFSET = 1;
const TIMEOUT_KIND_RESOLVE = 1;
const p_now = performance.now.bind(performance);
const raceTimeout = (promise, ms, resolveOnTimeout, timeoutValue) => new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
        if (done)
            return;
        done = true;
        if (resolveOnTimeout)
            resolve(timeoutValue);
        else
            reject(timeoutValue);
    }, ms);
    promise.then((value) => {
        if (done)
            return;
        done = true;
        clearTimeout(timer);
        resolve(value);
    }, (err) => {
        if (done)
            return;
        done = true;
        clearTimeout(timer);
        reject(err);
    });
});
const nowStamp = (now) => (Math.floor(now()) & TASK_SLOT_META_VALUE_MASK) >>> 0;
const applyTimeoutBudget = (promise, slot, spec, now) => {
    const elapsed = (nowStamp(now) - getTaskSlotMeta(slot)) & TASK_SLOT_META_VALUE_MASK;
    const remaining = spec.ms - elapsed;
    if (!(remaining > 0)) {
        // Prevent late unhandled rejections from the original promise.
        promise.then(() => { }, () => { });
        return spec.kind === TIMEOUT_KIND_RESOLVE
            ? Promise.resolve(spec.value)
            : Promise.reject(spec.value);
    }
    const timeoutMs = Math.max(1, Math.floor(remaining));
    return raceTimeout(promise, timeoutMs, spec.kind === TIMEOUT_KIND_RESOLVE, spec.value);
};
const NO_ABORT_SIGNAL = -1;
const readSignal = (slot) => {
    const encodedSignal = getTaskFunctionMeta(slot);
    if (encodedSignal === 0)
        return NO_ABORT_SIGNAL;
    const signal = (encodedSignal - ABORT_SIGNAL_META_OFFSET) | 0;
    return signal >= 0 ? signal : NO_ABORT_SIGNAL;
};
const throwIfAborted = (signal, hasAborted) => {
    if (signal === NO_ABORT_SIGNAL)
        return;
    if (hasAborted(signal))
        throw new Error("Task aborted");
};
const makeToolkitCache = (hasAborted) => {
    const bySignal = [];
    return (signal) => {
        let toolkit = bySignal[signal];
        if (toolkit)
            return toolkit;
        const hasAbortedMethod = () => hasAborted(signal);
        toolkit = {
            hasAborted: hasAbortedMethod,
        };
        bySignal[signal] = toolkit;
        return toolkit;
    };
};
export const composeWorkerRunner = ({ job, timeout, hasAborted, now, }) => {
    const nowTime = now ?? p_now;
    if (!hasAborted) {
        if (!timeout) {
            return (slot) => job(slot.value);
        }
        return (slot) => {
            const result = job(slot.value);
            if (!(result instanceof Promise))
                return result;
            return applyTimeoutBudget(result, slot, timeout, nowTime);
        };
    }
    const getToolkit = makeToolkitCache(hasAborted);
    if (!timeout) {
        return (slot) => {
            const signal = readSignal(slot);
            throwIfAborted(signal, hasAborted);
            if (signal === NO_ABORT_SIGNAL)
                return job(slot.value);
            return job(slot.value, getToolkit(signal));
        };
    }
    return (slot) => {
        const signal = readSignal(slot);
        throwIfAborted(signal, hasAborted);
        const result = signal === NO_ABORT_SIGNAL
            ? job(slot.value)
            : job(slot.value, getToolkit(signal));
        if (!(result instanceof Promise))
            return result;
        return applyTimeoutBudget(result, slot, timeout, nowTime);
    };
};
