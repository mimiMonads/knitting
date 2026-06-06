import RingQueue from "../ipc/tools/ring-queue.ts";
import {
  attachPayloadTransportFinalizer,
  type Lock2,
  runTaskFinalizers,
  type Task,
  TaskFlag,
  TaskIndex,
} from "../memory/lock.ts";
import type { WorkerComposedWithKey } from "./task-loader.ts";
import { composeWorkerRunner } from "./composable-runners.ts";
import type { WorkerSettings } from "../types.ts";
import { BUFFER_REFERENCE_RETURN_RELEASE_TOKEN } from "../connections/buffer-reference.ts";

type ArgumentsForCreateWorkerQueue = {
  listOfFunctions: WorkerComposedWithKey[];
  workerOptions?: WorkerSettings;
  lock: Lock2;
  returnLock: Lock2;
  borrowReturnedBufferReferences?: boolean;
  hasAborted?: (signal: number) => boolean;
  now?: () => number;
};

export type CreateWorkerRxQueue = ReturnType<typeof createWorkerRxQueue>;
export const createWorkerRxQueue = (
  {
    listOfFunctions,
    workerOptions,
    lock,
    returnLock,
    borrowReturnedBufferReferences,
    hasAborted,
    now,
  }: ArgumentsForCreateWorkerQueue,
) => {
  const PLACE_HOLDER = (_?: unknown) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
  };

  let hasAnythingFinished = 0;
  let awaiting = 0;

  const jobs = listOfFunctions.reduce((acc, fixed) => (
    acc.push(fixed.run), acc
  ), [] as Array<(args: unknown, abortToolkit?: unknown) => unknown>);

  const toWork = new RingQueue<Task>();
  const pendingFrames = new RingQueue<Task>();

  const toWorkPush = (slot: Task) => toWork.push(slot);
  const toWorkShift = () => toWork.shiftNoClear();
  const pendingShift = () => pendingFrames.shiftNoClear();
  const pendingUnshift = (slot: Task) => pendingFrames.unshift(slot);
  const pendingPush = (slot: Task) => pendingFrames.push(slot);
  const recyclePush = (slot: Task) => lock.recyclecList.push(slot);
  const FUNCTION_ID_MASK = 0xFFFF;
  const IDX_FLAGS = TaskIndex.FlagsToHost;
  const FLAG_REJECT = TaskFlag.Reject;

  // Return-payload finalizers wait until the host consumes the return.
  // Quiescence (hostBits XOR workerBits == 0) lets us release them in batch.
  const a_load = Atomics.load;
  const returnHostBits = returnLock.hostBits;
  const returnWorkerBits = returnLock.workerBits;
  const deferredReleases: Array<() => void> = [];
  const explicitReturnReleases = new Map<string, () => void>();
  const drainReturnReleases = () => {
    if (deferredReleases.length === 0) return;
    if ((a_load(returnHostBits, 0) ^ a_load(returnWorkerBits, 0)) !== 0) return;
    for (let i = 0; i < deferredReleases.length; i++) {
      try {
        deferredReleases[i]!();
      } catch {
        // best effort
      }
    }
    deferredReleases.length = 0;
  };
  const releaseReturnedBufferReference = (token: bigint): void => {
    const key = token.toString();
    const release = explicitReturnReleases.get(key);
    if (release === undefined) return;
    explicitReturnReleases.delete(key);
    try {
      release();
    } catch {
      // best effort
    }
  };

  const runByIndex = listOfFunctions.reduce((acc, fixed, idx) => {
    const job = jobs[idx]!;
    acc.push(composeWorkerRunner({
      job,
      timeout: fixed.timeout,
      hasAborted,
      now,
    }));
    return acc;
  }, [] as Array<(slot: Task) => unknown>);

  const hasCompleted = workerOptions?.resolveAfterFinishingAll === true
    ? () => hasAnythingFinished !== 0 && toWork.size === 0
    : () => hasAnythingFinished !== 0;

  const { decode, resolved } = lock;
  const resolvedShift = () => resolved.shiftNoClear();

  const enqueueLock = () => {
    if (!decode()) return false;

    let task = resolvedShift();
    while (task) {
      task.resolve = PLACE_HOLDER;
      task.reject = PLACE_HOLDER;
      attachPayloadTransportFinalizer(task, task.value);
      toWorkPush(task);
      task = resolvedShift();
    }
    return true;
  };

  const encodeReturnSafe = (slot: Task) => {
    if (!returnLock.encode(slot)) return false;

    return true;
  };

  const sendReturn = (slot: Task, shouldReject: boolean) => {
    slot[IDX_FLAGS] = shouldReject ? FLAG_REJECT : 0;
    if (!encodeReturnSafe(slot)) return false;
    // Preserve return finalizers past slot recycle; release after drain.
    if (slot.finalize !== undefined) {
      const token = (slot.finalize as (() => void) & {
        [BUFFER_REFERENCE_RETURN_RELEASE_TOKEN]?: bigint;
      })[BUFFER_REFERENCE_RETURN_RELEASE_TOKEN];
      if (token === undefined || borrowReturnedBufferReferences !== true) {
        deferredReleases.push(slot.finalize);
      } else {
        explicitReturnReleases.set(token.toString(), slot.finalize);
      }
      slot.finalize = undefined;
    }
    hasAnythingFinished--;
    recyclePush(slot);
    return true;
  };

  const settleNow = (
    slot: Task,
    isError: boolean,
    value: unknown,
    wasAwaited: boolean,
  ) => {
    runTaskFinalizers(slot);
    slot.value = value;
    hasAnythingFinished++;
    if (wasAwaited && awaiting > 0) awaiting--;
    const shouldReject = isError ||
      slot[IDX_FLAGS] === FLAG_REJECT;
    if (!sendReturn(slot, shouldReject)) pendingPush(slot);
  };

  const writeOne = () => {
    const slot = pendingShift();
    if (!slot) return false;
    if (!sendReturn(slot, slot[IDX_FLAGS] === FLAG_REJECT)) {
      pendingUnshift(slot);
      return false;
    }
    return true;
  };

  return {
    hasCompleted,
    hasPending: () => toWork.size !== 0,
    writeBatch: (max: number) => {
      let wrote = 0;
      while (wrote < max) {
        if (!writeOne()) break;
        wrote++;
      }
      return wrote;
    },
    serviceBatchImmediate: () => {
      let processed = 0;

      while (processed < 5 && toWork.size !== 0) {
        const slot = toWorkShift()!;

        try {
          const fnIndex = slot[TaskIndex.FunctionID] & FUNCTION_ID_MASK;
          const result = runByIndex[fnIndex]!(slot);
          slot[IDX_FLAGS] = 0;
          slot.value = null;
          if (result instanceof Promise) {
            awaiting++;

            result.then(
              (value) => settleNow(slot, false, value, true),
              (err) => settleNow(slot, true, err, true),
            );
          } else {
            settleNow(slot, false, result, false);
          }
        } catch (err) {
          settleNow(slot, true, err, false);
        }

        ++processed;
      }

      return processed;
    },
    enqueueLock,
    drainReturnReleases,
    releaseReturnedBufferReference,
    hasAwaiting: () => awaiting > 0,
    getAwaiting: () => awaiting,
  };
};
