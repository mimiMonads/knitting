import RingQueue from "../ipc/tools/ring-queue.js";
import { TaskFlag, TaskIndex, } from "../memory/lock.js";
import { composeWorkerRunner } from "./composable-runners.js";
// Create and manage a working queue.
export const createWorkerRxQueue = ({ listOfFunctions, workerOptions, lock, returnLock, hasAborted, now, }) => {
    const PLACE_HOLDER = (_) => {
        throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
    };
    let hasAnythingFinished = 0;
    let awaiting = 0;
    const jobs = listOfFunctions.reduce((acc, fixed) => (acc.push(fixed.run), acc), []);
    const toWork = new RingQueue();
    const pendingFrames = new RingQueue();
    const toWorkPush = (slot) => toWork.push(slot);
    const toWorkShift = () => toWork.shiftNoClear();
    const pendingShift = () => pendingFrames.shiftNoClear();
    const pendingUnshift = (slot) => pendingFrames.unshift(slot);
    const pendingPush = (slot) => pendingFrames.push(slot);
    const recyclePush = (slot) => lock.recyclecList.push(slot);
    const FUNCTION_ID_MASK = 0xFFFF;
    const IDX_FLAGS = TaskIndex.FlagsToHost;
    const FLAG_REJECT = TaskFlag.Reject;
    const runByIndex = listOfFunctions.reduce((acc, fixed, idx) => {
        const job = jobs[idx];
        acc.push(composeWorkerRunner({
            job,
            timeout: fixed.timeout,
            hasAborted,
            now,
        }));
        return acc;
    }, []);
    const hasCompleted = workerOptions?.resolveAfterFinishingAll === true
        ? () => hasAnythingFinished !== 0 && toWork.size === 0
        : () => hasAnythingFinished !== 0;
    const { decode, resolved } = lock;
    const resolvedShift = () => resolved.shiftNoClear();
    const enqueueLock = () => {
        if (!decode())
            return false;
        let task = resolvedShift();
        while (task) {
            task.resolve = PLACE_HOLDER;
            task.reject = PLACE_HOLDER;
            toWorkPush(task);
            task = resolvedShift();
        }
        return true;
    };
    const encodeReturnSafe = (slot) => {
        if (!returnLock.encode(slot))
            return false;
        return true;
    };
    const sendReturn = (slot, shouldReject) => {
        slot[IDX_FLAGS] = shouldReject ? FLAG_REJECT : 0;
        if (!encodeReturnSafe(slot))
            return false;
        hasAnythingFinished--;
        recyclePush(slot);
        return true;
    };
    const settleNow = (slot, isError, value, wasAwaited) => {
        slot.value = value;
        hasAnythingFinished++;
        if (wasAwaited && awaiting > 0)
            awaiting--;
        const shouldReject = isError ||
            slot[IDX_FLAGS] === FLAG_REJECT;
        if (!sendReturn(slot, shouldReject))
            pendingPush(slot);
    };
    const writeOne = () => {
        const slot = pendingShift();
        if (!slot)
            return false;
        if (!sendReturn(slot, slot[IDX_FLAGS] === FLAG_REJECT)) {
            pendingUnshift(slot);
            return false;
        }
        return true;
    };
    return {
        hasCompleted,
        hasPending: () => toWork.size !== 0,
        writeBatch: (max) => {
            let wrote = 0;
            while (wrote < max) {
                if (!writeOne())
                    break;
                wrote++;
            }
            return wrote;
        },
        serviceBatchImmediate: () => {
            let processed = 0;
            while (processed < 5 && toWork.size !== 0) {
                const slot = toWorkShift();
                try {
                    const fnIndex = slot[TaskIndex.FunctionID] & FUNCTION_ID_MASK;
                    const result = runByIndex[fnIndex](slot);
                    // Slot 0 is reused for response flags; clear request FunctionID value.
                    slot[IDX_FLAGS] = 0;
                    slot.value = null;
                    if (result instanceof Promise) {
                        awaiting++;
                        result.then((value) => settleNow(slot, false, value, true), (err) => settleNow(slot, true, err, true));
                    }
                    else {
                        settleNow(slot, false, result, false);
                    }
                }
                catch (err) {
                    settleNow(slot, true, err, false);
                }
                ++processed;
            }
            return processed;
        },
        enqueueLock,
        hasAwaiting: () => awaiting > 0,
        getAwaiting: () => awaiting,
    };
};
