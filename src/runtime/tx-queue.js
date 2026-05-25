import { makeTask, resetTaskLocalFlags, TaskIndex, } from "../memory/lock.js";
import { withResolvers } from "../common/with-resolvers.js";
import { AbortSignalPoolExhausted, OneShotDeferred, } from "../shared/abortSignal.js";
const SLOT_INDEX_MASK = 31;
const SLOT_META_MASK = 0x07ffffff;
const SLOT_META_SHIFT = 5;
const FUNCTION_ID_MASK = 0xffff;
const FUNCTION_META_MASK = 0xffff;
const FUNCTION_META_SHIFT = 16;
const ABORT_SIGNAL_META_OFFSET = 1;
const NO_ABORT_SIGNAL = -1;
const p_now = performance.now.bind(performance);
export function createHostTxQueue({ max, lock, returnLock, abortSignals, now, }) {
    const PLACE_HOLDER = (_) => {
        throw ("UNREACHABLE FROM PLACE HOLDER (main)");
    };
    const newSlot = (id) => {
        const task = makeTask();
        task[TaskIndex.ID] = id;
        task[TaskIndex.FunctionID] = 0;
        task.value = null;
        task.resolve = PLACE_HOLDER;
        task.reject = PLACE_HOLDER;
        return task;
    };
    const initialSize = max ?? 10;
    const queue = Array.from({ length: initialSize }, (_, index) => newSlot(index));
    const freeSockets = Array.from({ length: initialSize }, (_, i) => i);
    // Local count
    const freePush = (id) => freeSockets.push(id);
    const freePop = () => freeSockets.pop();
    const queuePush = (task) => queue.push(task);
    const { publish, flushPending, hasPendingFrames, getPendingFrameCount, getPendingPromiseCount, resetPendingState, } = lock;
    let inUsed = 0 | 0;
    const resetSignal = abortSignals?.resetSignal;
    const nowTime = now ?? p_now;
    const resolveReturn = returnLock.resolveHost({
        queue,
        activeRejectPlaceholder: PLACE_HOLDER,
        onResolved: (task) => {
            inUsed = (inUsed - 1) | 0;
            resetTaskLocalFlags(task);
            task.value = null;
            task.resolve = PLACE_HOLDER;
            task.reject = PLACE_HOLDER;
            freePush(task[TaskIndex.ID]);
        },
    });
    // Helpers
    const txIdle = () => getPendingFrameCount() === 0 && inUsed === getPendingPromiseCount();
    const rejectAll = (reason) => {
        for (let index = 0; index < queue.length; index++) {
            const slot = queue[index];
            if (slot.reject !== PLACE_HOLDER) {
                try {
                    slot.reject(reason);
                }
                catch {
                }
                slot.resolve = PLACE_HOLDER;
                slot.reject = PLACE_HOLDER;
                queue[index] = newSlot(index);
            }
        }
        resetPendingState();
        inUsed = 0 | 0;
    };
    const flushToWorker = () => flushPending();
    const enqueueKnown = (task) => {
        return publish(task);
    };
    return {
        rejectAll,
        hasPendingFrames,
        txIdle,
        completeFrame: resolveReturn,
        enqueue: (functionID, timeout, abortSignal) => {
            const HAS_TIMER = timeout !== undefined;
            const functionIDMasked = functionID & FUNCTION_ID_MASK;
            const USE_SIGNAL = abortSignal !== undefined && abortSignals !== undefined;
            return (rawArgs) => {
                // Expanding size if needed
                if (inUsed === queue.length) {
                    const newSize = inUsed + 32;
                    let current = queue.length;
                    while (newSize > current) {
                        queuePush(newSlot(current));
                        freePush(current);
                        current++;
                    }
                }
                const index = freePop();
                const slot = queue[index];
                const deferred = withResolvers();
                slot[TaskIndex.FunctionID] = functionIDMasked;
                if (USE_SIGNAL) {
                    const maybeSignal = abortSignals.getSignal();
                    if (maybeSignal === abortSignals.closeNow) {
                        return Promise.reject(AbortSignalPoolExhausted);
                    }
                    new OneShotDeferred(deferred, () => resetSignal(maybeSignal));
                    const encodedSignalMeta = ((maybeSignal + ABORT_SIGNAL_META_OFFSET) & FUNCTION_META_MASK) >>> 0;
                    slot[TaskIndex.FunctionID] =
                        ((encodedSignalMeta << FUNCTION_META_SHIFT) | functionIDMasked) >>> 0;
                }
                // Set info
                slot.value = rawArgs;
                slot[TaskIndex.ID] = index;
                slot.resolve = deferred.resolve;
                slot.reject = deferred.reject;
                if (HAS_TIMER) {
                    slot[TaskIndex.slotBuffer] =
                        ((slot[TaskIndex.slotBuffer] & SLOT_INDEX_MASK) |
                            ((((nowTime() >>> 0) & SLOT_META_MASK) << SLOT_META_SHIFT) >>> 0)) >>> 0;
                }
                void publish(slot);
                inUsed = (inUsed + 1) | 0;
                return deferred.promise;
            };
        },
        flushToWorker,
        enqueueKnown,
        settlePromisePayload: (task, isRejected, value) => {
            if (task.reject === PLACE_HOLDER)
                return false;
            if (isRejected) {
                try {
                    task.reject(value);
                }
                catch {
                }
                resetTaskLocalFlags(task);
                task.value = null;
                task.resolve = PLACE_HOLDER;
                task.reject = PLACE_HOLDER;
                inUsed = (inUsed - 1) | 0;
                freePush(task[TaskIndex.ID]);
                return false;
            }
            task.value = value;
            return enqueueKnown(task);
        },
    };
}
