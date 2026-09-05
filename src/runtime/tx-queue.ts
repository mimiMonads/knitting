// Side-effect import: registers the payload codec (cycle break for Andromeda;
// see lock.ts), ensuring registration before any lock2() call.
import "../memory/payloadCodec.ts";
import {
  type Lock2,
  makeTask,
  resetTaskLocalFlags,
  runTaskFinalizers,
  type Task,
  TaskIndex,
} from "../memory/lock.ts";
import { withResolvers } from "../common/with-resolvers.ts";
import type { AbortSignalOption, TaskTimeout } from "../types.ts";
import {
  AbortSignalPoolExhausted,
  OneShotDeferred,
  type SignalAbortStore,
} from "../shared/abortSignal.ts";

type RawArguments = unknown;
type WorkerResponse = unknown;
type FunctionID = number;
type QueueTask = Task;

export type MultiQueue = ReturnType<typeof createHostTxQueue>;
const SLOT_INDEX_MASK = 31;
const SLOT_META_MASK = 0x07ffffff;
const SLOT_META_SHIFT = 5;
const FUNCTION_ID_MASK = 0xffff;
const FUNCTION_META_MASK = 0xffff;
const FUNCTION_META_SHIFT = 16;
const ABORT_SIGNAL_META_OFFSET = 1;
const NO_ABORT_SIGNAL = -1;

type CreateHostTxQueueArgs = {
  max?: number;
  lock: Lock2;
  returnLock: Lock2;
  /**
   * Extra return locks to drain into the same pending registry.
   *
   * Under work stealing the host publishes into one shared submit lock and any
   * worker may claim the task, so the response comes back on whichever lane
   * executed it. Task IDs index this queue's `queue` array, which is
   * pool-global, so every lane's `resolveHost` can settle into it — the
   * stealing worker owns the response and the host demultiplexes by ID.
   *
   * When omitted, only `returnLock` is drained (the classic one-lane shape).
   */
  extraReturnLocks?: readonly Lock2[];
  abortSignals?: Pick<
    SignalAbortStore,
    "getSignal" | "setSignal" | "resetSignal" | "closeNow"
  >;
  now?: () => number;
};

const p_now = performance.now.bind(performance);

export function createHostTxQueue({
  max,
  lock,
  returnLock,
  extraReturnLocks,
  abortSignals,
  now,
}: CreateHostTxQueueArgs) {
  const PLACE_HOLDER = (_?: unknown) => {
    throw ("UNREACHABLE FROM PLACE HOLDER (main)");
  };

  const newSlot = (id: number) => {
    const task = makeTask() as QueueTask;
    task[TaskIndex.ID] = id;
    task[TaskIndex.FunctionID] = 0;
    task.value = null;
    task.resolve = PLACE_HOLDER;
    task.reject = PLACE_HOLDER;
    return task;
  };

  const initialSize = max ?? 10;
  const queue = Array.from(
    { length: initialSize },
    (_, index) => newSlot(index),
  );

  const freeSockets = Array.from(
    { length: initialSize },
    (_, i) => i,
  );

  const freePush = (id: number) => freeSockets.push(id);
  const freePop = () => freeSockets.pop();
  const queuePush = (task: QueueTask) => queue.push(task);
  const {
    publish,
    flushPending,
    hasPendingFrames,
    getPendingFrameCount,
    getPendingPromiseCount,
    resetPendingState,
  } = lock;
  let inUsed = 0 | 0;
  const resetSignal = abortSignals?.resetSignal;
  const nowTime = now ?? p_now;

  const onReturnResolved = (task: Task) => {
    inUsed = (inUsed - 1) | 0;
    resetTaskLocalFlags(task);
    runTaskFinalizers(task);
    task.value = null;
    task.resolve = PLACE_HOLDER;
    task.reject = PLACE_HOLDER;
    freePush(task[TaskIndex.ID]);
  };

  const returnResolvers = [
    returnLock,
    ...(extraReturnLocks ?? []),
  ].map((each) =>
    each.resolveHost({
      queue,
      activeRejectPlaceholder: PLACE_HOLDER,
      onResolved: onReturnResolved,
    })
  );
  const returnWaiters = [
    returnLock,
    ...(extraReturnLocks ?? []),
  ].map((each) =>
    typeof each.waitForHostChange === "function"
      ? each.waitForHostChange
      : () => undefined
  );
  const returnArmers = [
    returnLock,
    ...(extraReturnLocks ?? []),
  ].map((each) =>
    typeof each.setHostWaiterArmed === "function"
      ? each.setHostWaiterArmed
      : (_armed: boolean) => {}
  );
  const returnNativeArmers = [
    returnLock,
    ...(extraReturnLocks ?? []),
  ].map((each) =>
    typeof each.armHostNotifier === "function"
      ? each.armHostNotifier
      : () => false
  );
  const completeFrame = returnResolvers.length === 1
    ? returnResolvers[0]!
    : () => {
      let resolved = 0 | 0;
      for (let i = 0; i < returnResolvers.length; i++) {
        resolved = (resolved + returnResolvers[i]!()) | 0;
      }
      return resolved;
    };

  // A stealing queue has one private return lock per worker. Keep at most one
  // waitAsync waiter per lane: after lane A rings, lane B's unresolved waiter
  // must survive the next arm or Atomics.notify(..., 1) could wake an obsolete
  // waiter and starve the live one until the watchdog timeout.
  const completionArmed = new Uint8Array(returnWaiters.length);
  let completionWake: (() => void) | undefined;
  let completionGeneration = 0 | 0;
  const completionGenerations = new Int32Array(returnWaiters.length);
  // Reuse one callback per lane and capture the generation before re-arming.
  const completionCallbacks = returnWaiters.map((_, index) => () => {
    if (completionArmed[index] === 0) return;
    const generation = completionGenerations[index];
    completionArmed[index] = 0;
    returnArmers[index]!(false);
    if (generation !== completionGeneration) return;
    completionWake?.();
  });
  const setCompletionWaiterArmed = (armed: boolean) => {
    for (const setArmed of returnArmers) setArmed(armed);
  };
  const waitForCompletion = (
    onWake: () => void,
    timeoutMs?: number,
  ): boolean => {
    completionWake = onWake;
    let supported = true;

    for (let index = 0; index < returnWaiters.length; index++) {
      if (completionArmed[index] !== 0) {
        // Re-arm persistent waiters with an atomic check; a result may have
        // arrived while the gate was off, and setting ARMED alone can strand it.
        if (!returnNativeArmers[index]!()) {
          onWake();
          return true;
        }
        continue;
      }

      let wait;
      try {
        wait = returnWaiters[index]!(timeoutMs);
      } catch {
        wait = undefined;
      }
      if (wait === undefined) {
        supported = false;
        break;
      }

      completionArmed[index] = 1;
      completionGenerations[index] = completionGeneration;
      const wakeLane = completionCallbacks[index]!;

      if (!wait.async) {
        wakeLane();
        // A synchronous wake may disarm the whole queue, so stop here.
        return true;
      }
      Promise.resolve(wait.value).then(wakeLane, wakeLane);
    }

    if (!supported) {
      completionWake = undefined;
      setCompletionWaiterArmed(false);
      completionGeneration = (completionGeneration + 1) | 0;
    }
    return supported;
  };

  /**
   * Native callbacks (Deno's threadSafe UnsafeCallback) cannot use waitAsync,
   * but they use the same shared arm word. Each lane is armed and checked for
   * a publication in one operation; a false return means the dispatcher must
   * drain again rather than sleep waiting for a ring that already happened.
   */
  const armCompletionNotifier = (): boolean => {
    for (const arm of returnNativeArmers) {
      if (arm()) continue;
      setCompletionWaiterArmed(false);
      return false;
    }
    return true;
  };

  const hasActiveTasks = () => {
    const count = (inUsed - getPendingPromiseCount()) | 0;
    return count > 0;
  };

  const txIdle = () => getPendingFrameCount() === 0 && !hasActiveTasks();

  const rejectAll = (reason: string) => {
    for (let index = 0; index < queue.length; index++) {
      const slot = queue[index];
      if (slot.reject !== PLACE_HOLDER) {
        try {
          slot.reject(reason);
        } catch {
        }
        runTaskFinalizers(slot);
        slot.resolve = PLACE_HOLDER;
        slot.reject = PLACE_HOLDER;

        queue[index] = newSlot(index);
      }
    }

    resetPendingState();
    inUsed = 0 | 0;
  };

  const flushToWorker = () => flushPending();

  const enqueueKnown = (task: QueueTask) => {
    return publish(task);
  };

  return {
    rejectAll,
    hasPendingFrames,
    txIdle,
    completeFrame,
    waitForCompletion,
    armCompletionNotifier,
    setCompletionWaiterArmed,
    enqueue: (
      functionID: FunctionID,
      timeout?: TaskTimeout,
      abortSignal?: AbortSignalOption,
    ) => {
      const HAS_TIMER = timeout !== undefined;
      const functionIDMasked = functionID & FUNCTION_ID_MASK;
      const USE_SIGNAL = abortSignal !== undefined &&
        abortSignals !== undefined;

      return (rawArgs: RawArguments) => {
        if (inUsed === queue.length) {
          const newSize = inUsed + 32;
          let current = queue.length;

          while (newSize > current) {
            queuePush(newSlot(current));
            freePush(current);
            current++;
          }
        }

        const index = freePop()!;
        const slot = queue[index];
        const deferred = withResolvers<WorkerResponse>();

        slot[TaskIndex.FunctionID] = functionIDMasked;
        if (USE_SIGNAL) {
          const maybeSignal = abortSignals.getSignal();
          if (maybeSignal === abortSignals.closeNow) {
            return Promise.reject(AbortSignalPoolExhausted);
          }

          new OneShotDeferred(
            deferred,
            () => resetSignal!(maybeSignal),
            () => {
              abortSignals.setSignal(maybeSignal);
            },
          );
          const encodedSignalMeta =
            ((maybeSignal + ABORT_SIGNAL_META_OFFSET) & FUNCTION_META_MASK) >>>
            0;
          slot[TaskIndex.FunctionID] =
            ((encodedSignalMeta << FUNCTION_META_SHIFT) | functionIDMasked) >>>
            0;
        }

        slot.value = rawArgs;

        slot[TaskIndex.ID] = index;
        slot.resolve = deferred.resolve;
        slot.reject = deferred.reject;

        if (HAS_TIMER) {
          slot[TaskIndex.slotBuffer] = (
            (slot[TaskIndex.slotBuffer] & SLOT_INDEX_MASK) |
            ((((nowTime() >>> 0) & SLOT_META_MASK) << SLOT_META_SHIFT) >>> 0)
          ) >>> 0;
        }

        void publish(slot);

        inUsed = (inUsed + 1) | 0;

        return deferred.promise;
      };
    },
    flushToWorker,
    enqueueKnown,
    settlePromisePayload: (
      task: QueueTask,
      isRejected: boolean,
      value: unknown,
    ) => {
      if (task.reject === PLACE_HOLDER) return false;
      if (isRejected) {
        try {
          task.reject(value);
        } catch {
        }
        resetTaskLocalFlags(task);
        runTaskFinalizers(task);
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
