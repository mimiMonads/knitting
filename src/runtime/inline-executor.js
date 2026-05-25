import { withResolvers } from "../common/with-resolvers.js";
import RingQueue from "../ipc/tools/ring-queue.js";
import { createRuntimeMessageChannel } from "../common/worker-runtime.js";
const normalizeTimeout = (timeout) => {
    if (timeout == null)
        return undefined;
    if (typeof timeout === "number") {
        return timeout >= 0
            ? { ms: timeout, kind: 0 /* TimeoutKind.Reject */, value: new Error("Task timeout") }
            : undefined;
    }
    const ms = timeout.time;
    if (!(ms >= 0))
        return undefined;
    if ("default" in timeout) {
        return { ms, kind: 1 /* TimeoutKind.Resolve */, value: timeout.default };
    }
    if (timeout.maybe === true) {
        return { ms, kind: 1 /* TimeoutKind.Resolve */, value: undefined };
    }
    if ("error" in timeout) {
        return { ms, kind: 0 /* TimeoutKind.Reject */, value: timeout.error };
    }
    return { ms, kind: 0 /* TimeoutKind.Reject */, value: new Error("Task timeout") };
};
const raceTimeout = (promise, spec) => new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
        if (done)
            return;
        done = true;
        if (spec.kind === 1 /* TimeoutKind.Resolve */) {
            resolve(spec.value);
        }
        else {
            reject(spec.value);
        }
    }, spec.ms);
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
const INLINE_ABORT_TOOLKIT = (() => {
    const hasAborted = () => false;
    return {
        hasAborted,
    };
})();
const composeInlineCallable = (fn, timeout, useAbortToolkit = false) => {
    const normalized = normalizeTimeout(timeout);
    const run = useAbortToolkit
        ? (args) => fn(args, INLINE_ABORT_TOOLKIT)
        : fn;
    if (!normalized)
        return run;
    return (args) => {
        const result = run(args);
        return result instanceof Promise ? raceTimeout(result, normalized) : result;
    };
};
export const createInlineExecutor = ({ tasks, genTaskID, batchSize, }) => {
    const entries = Object.values(tasks)
        .sort((a, b) => a.id - b.id);
    const runners = entries.map((entry) => composeInlineCallable(entry.f, entry.timeout, entry.abortSignal !== undefined));
    const initCap = 16;
    let fnByIndex = new Int32Array(initCap);
    let stateByIndex = new Int8Array(initCap).fill(-1 /* SlotStateMacro.Free */);
    let argsByIndex = new Array(initCap);
    let taskIdByIndex = new Array(initCap).fill(-1);
    let deferredByIndex = new Array(initCap);
    const freeStack = new Array(initCap);
    let freeTop = initCap;
    for (let i = 0; i < initCap; i++)
        freeStack[i] = initCap - 1 - i;
    const pendingQueue = new RingQueue(initCap);
    let working = 0;
    let isInMacro = false;
    let isInMicro = false;
    const batchLimit = Number.isFinite(batchSize)
        ? Math.max(1, Math.floor(batchSize ?? 1))
        : Number.POSITIVE_INFINITY;
    const channel = createRuntimeMessageChannel();
    const port1 = channel.port1;
    const port2 = channel.port2;
    const post2 = (message) => port2.postMessage(message);
    const hasPending = () => pendingQueue.isEmpty === false;
    const queueMicro = typeof queueMicrotask === "function"
        ? queueMicrotask
        : (callback) => Promise.resolve().then(callback);
    const scheduleMacro = () => {
        if (working === 0 || isInMacro)
            return;
        isInMacro = true;
        post2(null);
    };
    const send = () => {
        if (working === 0 || isInMacro || isInMicro)
            return;
        isInMicro = true;
        queueMicro(runMicroLoop);
    };
    const enqueue = (index) => {
        pendingQueue.push(index);
        send();
    };
    const enqueueIfCurrent = (index, taskID) => {
        if (stateByIndex[index] !== 0 /* SlotStateMacro.Pending */ ||
            taskIdByIndex[index] !== taskID)
            return;
        enqueue(index);
    };
    const settleIfCurrent = (index, taskID, isError, value) => {
        if (stateByIndex[index] !== 0 /* SlotStateMacro.Pending */ ||
            taskIdByIndex[index] !== taskID)
            return;
        const deferred = deferredByIndex[index];
        if (deferred) {
            if (isError)
                deferred.reject(value);
            else
                deferred.resolve(value);
        }
        cleanup(index);
    };
    function allocIndex() {
        if (freeTop > 0)
            return freeStack[--freeTop];
        const oldCap = fnByIndex.length;
        const newCap = oldCap << 1;
        const nextFnByIndex = new Int32Array(newCap);
        nextFnByIndex.set(fnByIndex);
        fnByIndex = nextFnByIndex;
        const nextStateByIndex = new Int8Array(newCap);
        nextStateByIndex.fill(-1 /* SlotStateMacro.Free */);
        nextStateByIndex.set(stateByIndex);
        stateByIndex = nextStateByIndex;
        argsByIndex.length = newCap;
        taskIdByIndex.length = newCap;
        taskIdByIndex.fill(-1, oldCap);
        deferredByIndex.length = newCap;
        for (let i = newCap - 1; i >= oldCap; --i) {
            freeStack[freeTop++] = i;
        }
        return freeStack[--freeTop];
    }
    function processLoop(fromMicro = false) {
        let processed = 0;
        while (processed < batchLimit) {
            const maybeIndex = pendingQueue.shiftNoClear();
            if (maybeIndex === undefined)
                break;
            const index = maybeIndex | 0;
            if (stateByIndex[index] !== 0 /* SlotStateMacro.Pending */)
                continue;
            const taskID = taskIdByIndex[index];
            try {
                const args = argsByIndex[index];
                const fnId = fnByIndex[index];
                const res = runners[fnId](args);
                if (!(res instanceof Promise)) {
                    settleIfCurrent(index, taskID, false, res);
                    processed++;
                    continue;
                }
                res.then((value) => settleIfCurrent(index, taskID, false, value), (err) => settleIfCurrent(index, taskID, true, err));
                processed++;
            }
            catch (err) {
                settleIfCurrent(index, taskID, true, err);
                processed++;
            }
        }
        if (hasPending()) {
            if (fromMicro) {
                scheduleMacro();
            }
            else {
                post2(null);
            }
            return;
        }
        if (!fromMicro) {
            isInMacro = false;
        }
    }
    function runMicroLoop() {
        if (!isInMicro)
            return;
        processLoop(true);
        isInMicro = false;
    }
    function cleanup(index) {
        working--;
        stateByIndex[index] = -1 /* SlotStateMacro.Free */;
        fnByIndex[index] = 0;
        taskIdByIndex[index] = -1;
        argsByIndex[index] = undefined;
        deferredByIndex[index] = undefined;
        freeStack[freeTop++] = index;
        if (working === 0)
            isInMacro = false;
    }
    const call = ({ fnNumber }) => (args) => {
        const taskID = genTaskID();
        const deferred = withResolvers();
        const index = allocIndex();
        taskIdByIndex[index] = taskID;
        argsByIndex[index] = args;
        fnByIndex[index] = fnNumber | 0;
        deferredByIndex[index] = deferred;
        stateByIndex[index] = 0 /* SlotStateMacro.Pending */;
        working++;
        if (args instanceof Promise) {
            args.then((value) => {
                if (taskIdByIndex[index] !== taskID)
                    return;
                argsByIndex[index] = value;
                enqueueIfCurrent(index, taskID);
            }, (err) => settleIfCurrent(index, taskID, true, err));
        }
        else {
            enqueue(index);
        }
        return deferred.promise;
    };
    //@ts-ignore
    port1.onmessage = () => processLoop(false);
    return {
        kills: async () => {
            for (let index = 0; index < stateByIndex.length; index++) {
                if (stateByIndex[index] !== 0 /* SlotStateMacro.Pending */)
                    continue;
                try {
                    deferredByIndex[index]?.reject("Thread closed");
                }
                catch {
                }
            }
            //@ts-ignore
            port1.onmessage = null;
            port1.close?.();
            //@ts-ignore
            port2.onmessage = null;
            port2.close?.();
            pendingQueue.clear();
            freeTop = 0;
            freeStack.length = 0;
            argsByIndex.fill(undefined);
            taskIdByIndex.fill(-1);
            deferredByIndex.fill(undefined);
            fnByIndex.fill(0);
            stateByIndex.fill(-1 /* SlotStateMacro.Free */);
            working = 0;
            isInMacro = false;
            isInMicro = false;
        },
        call,
        txIdle: () => working === 0,
    };
};
