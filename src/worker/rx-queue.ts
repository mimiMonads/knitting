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

type ArgumentsForCreateWorkerQueue = {
  listOfFunctions: WorkerComposedWithKey[];
  workerOptions?: WorkerSettings;
  lock: Lock2;
  returnLock: Lock2;
  hasAborted?: (signal: number) => boolean;
  now?: () => number;
  /**
   * Work-stealing discipline: only claim when this worker has nothing left to
   * run. Without it a worker keeps claiming whole regions on top of a backlog
   * it has not started, which is exactly the hoarding stealing exists to
   * prevent — the queued tasks would be better taken by an idle peer.
   *
   * Off for the classic per-lane path, where the host has already assigned
   * these tasks to this lane and batching them is a win.
   */
  stealing?: boolean;
};

/** Tasks run per `serviceBatchImmediate` call before returning to the loop. */
const SERVICE_BATCH_MAX = 32;

export type CreateWorkerRxQueue = ReturnType<typeof createWorkerRxQueue>;
export const createWorkerRxQueue = (
  {
    listOfFunctions,
    workerOptions,
    lock,
    returnLock,
    hasAborted,
    now,
    stealing,
  }: ArgumentsForCreateWorkerQueue,
) => {
  const PLACE_HOLDER = (_?: unknown) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
  };

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
  const drainReturnReleases = () => {
    if (deferredReleases.length === 0) return;
    // `returnHostBits` is the publication word of the return lock, and only
    // this thread ever writes it (encode() toggles hostBits, the host toggles
    // workerBits). Reading our own word plainly skips an `Atomics.load`, which
    // is a non-inlined call an order of magnitude dearer than a plain read;
    // the peer's word still needs the atomic.
    if ((returnHostBits[0]! ^ a_load(returnWorkerBits, 0)) !== 0) return;
    for (let i = 0; i < deferredReleases.length; i++) {
      try {
        deferredReleases[i]!();
      } catch {
        // best effort
      }
    }
    deferredReleases.length = 0;
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

  // A settled task is either written into the return lock straight away or
  // parked in `pendingFrames`, so the queue's own size already answers "is
  // there anything left to flush" — the separate counter this used to keep was
  // an increment and a decrement per task tracking a value it could read.
  const hasCompleted = workerOptions?.resolveAfterFinishingAll === true
    ? () => pendingFrames.size !== 0 && toWork.size === 0
    : () => pendingFrames.size !== 0;

  const { decode, resolved } = lock;
  const resolvedShift = () => resolved.shiftNoClear();

  const enqueueLock = () => {
    // Steal only when idle: leaving work unclaimed lets a free peer take it.
    if (stealing && toWork.size !== 0) return false;
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

  const returnEncode = returnLock.encode;

  const sendReturn = (slot: Task, shouldReject: boolean) => {
    slot[IDX_FLAGS] = shouldReject ? FLAG_REJECT : 0;
    if (!returnEncode(slot)) return false;
    // Preserve return finalizers past slot recycle; release after drain.
    if (slot.finalize !== undefined) {
      deferredReleases.push(slot.finalize);
      slot.finalize = undefined;
    }
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

      // Every trip back out to the dispatch loop costs a claim attempt and the
      // per-pass bookkeeping, so a low cap makes that scaffolding a per-task
      // tax on cheap tasks. Run a longer run when the return lock is keeping
      // up, and cut it short the moment a settle lands in `pendingFrames` --
      // that means the return region is full and the right move is to go
      // flush it rather than pile up more finished work.
      while (processed < SERVICE_BATCH_MAX && toWork.size !== 0) {
        const slot = toWorkShift()!;

        try {
          const fnIndex = slot[TaskIndex.FunctionID] & FUNCTION_ID_MASK;
          const result = runByIndex[fnIndex]!(slot);
          slot[IDX_FLAGS] = 0;
          if (result instanceof Promise) {
            slot.value = null;
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
        if (pendingFrames.size !== 0) break;
      }

      return processed;
    },
    enqueueLock,
    drainReturnReleases,
    hasAwaiting: () => awaiting > 0,
    getAwaiting: () => awaiting,
  };
};
