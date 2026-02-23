import type { TaskTimeout, WorkerCall, tasks } from "../types.ts";
import { MessageChannel } from "node:worker_threads";
import { withResolvers } from "../common/with-resolvers.ts";
import RingQueue from "../ipc/tools/RingQueue.ts";

type WorkerCallable = (args: unknown, abortToolkit?: unknown) => unknown;

interface Deferred {
  promise: Promise<unknown>;
  resolve: (v: unknown | PromiseLike<unknown>) => void;
  reject: (v?: unknown) => void;
}

const enum SlotStateMacro {
  Free = -1,
  Pending = 0,
}

const enum TimeoutKind {
  Reject = 0,
  Resolve = 1,
}

type TimeoutSpec = {
  ms: number;
  kind: TimeoutKind;
  value: unknown;
};

const normalizeTimeout = (timeout?: TaskTimeout): TimeoutSpec | undefined => {
  if (timeout == null) return undefined;
  if (typeof timeout === "number") {
    return timeout >= 0
      ? { ms: timeout, kind: TimeoutKind.Reject, value: new Error("Task timeout") }
      : undefined;
  }
  const ms = timeout.time;
  if (!(ms >= 0)) return undefined;
  if ("default" in timeout) {
    return { ms, kind: TimeoutKind.Resolve, value: timeout.default };
  }
  if (timeout.maybe === true) {
    return { ms, kind: TimeoutKind.Resolve, value: undefined };
  }
  if ("error" in timeout) {
    return { ms, kind: TimeoutKind.Reject, value: timeout.error };
  }
  return { ms, kind: TimeoutKind.Reject, value: new Error("Task timeout") };
};

const raceTimeout = (
  promise: Promise<unknown>,
  spec: TimeoutSpec,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      if (spec.kind === TimeoutKind.Resolve) {
        resolve(spec.value);
      } else {
        reject(spec.value);
      }
    }, spec.ms);

    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });

const INLINE_ABORT_TOOLKIT = (() => {
  const hasAborted = () => false;
  return {
    hasAborted,
  };
})();

const composeInlineCallable = (
  fn: WorkerCallable,
  timeout?: TaskTimeout,
  useAbortToolkit = false,
): WorkerCallable => {
  const normalized = normalizeTimeout(timeout);
  const run = useAbortToolkit
    ? (args: unknown) => fn(args, INLINE_ABORT_TOOLKIT)
    : fn;

  if (!normalized) return run;
  return (args: unknown) => {
    const result = run(args);
    return result instanceof Promise ? raceTimeout(result, normalized) : result;
  };
};

export const createInlineExecutor = ({
  tasks,
  genTaskID,
  batchSize,
}: {
  tasks: tasks;
  genTaskID: () => number;
  batchSize?: number;
}) => {
  const entries = Object.values(tasks)
    .sort((a, b) => a.id - b.id);
  const runners = entries.map((entry) =>
    composeInlineCallable(
      entry.f as WorkerCallable,
      entry.timeout,
      entry.abortSignal !== undefined,
    )
  );

  const initCap = 16;
  let fnByIndex = new Int32Array(initCap);
  let stateByIndex = new Int8Array(initCap).fill(SlotStateMacro.Free);
  let argsByIndex = new Array<unknown>(initCap);
  let taskIdByIndex = new Array<number>(initCap).fill(-1);
  let deferredByIndex = new Array<Deferred | undefined>(initCap);

  const freeStack = new Array<number>(initCap);
  let freeTop = initCap;
  for (let i = 0; i < initCap; i++) freeStack[i] = initCap - 1 - i;
  const pendingQueue = new RingQueue<number>(initCap);

  let working = 0;
  let isInMacro = false;
  let isInMicro = false;
  const batchLimit = Number.isFinite(batchSize)
    ? Math.max(1, Math.floor(batchSize ?? 1))
    : Number.POSITIVE_INFINITY;

  const channel = new MessageChannel();
  const port1 = channel.port1;
  const port2 = channel.port2;
  const post2 = port2.postMessage.bind(port2);
  const hasPending = () => pendingQueue.isEmpty === false;
  const queueMicro = typeof queueMicrotask === "function"
    ? queueMicrotask
    : (callback: () => void) => Promise.resolve().then(callback);

  const scheduleMacro = () => {
    if (working === 0 || isInMacro) return;
    isInMacro = true;
    post2(null);
  };

  const send = () => {
    if (working === 0 || isInMacro || isInMicro) return;
    isInMicro = true;
    queueMicro(runMicroLoop);
  };

  const enqueue = (index: number) => {
    pendingQueue.push(index);
    send();
  };

  const enqueueIfCurrent = (index: number, taskID: number) => {
    if (
      stateByIndex[index] !== SlotStateMacro.Pending ||
      taskIdByIndex[index] !== taskID
    ) return;
    enqueue(index);
  };

  const settleIfCurrent = (
    index: number,
    taskID: number,
    isError: boolean,
    value: unknown,
  ) => {
    if (
      stateByIndex[index] !== SlotStateMacro.Pending ||
      taskIdByIndex[index] !== taskID
    ) return;

    const deferred = deferredByIndex[index];
    if (deferred) {
      if (isError) deferred.reject(value);
      else deferred.resolve(value);
    }
    cleanup(index);
  };

  function allocIndex(): number {
    if (freeTop > 0) return freeStack[--freeTop]!;

    const oldCap = fnByIndex.length;
    const newCap = oldCap << 1;

    const nextFnByIndex = new Int32Array(newCap);
    nextFnByIndex.set(fnByIndex);
    fnByIndex = nextFnByIndex;

    const nextStateByIndex = new Int8Array(newCap);
    nextStateByIndex.fill(SlotStateMacro.Free);
    nextStateByIndex.set(stateByIndex);
    stateByIndex = nextStateByIndex;

    argsByIndex.length = newCap;
    taskIdByIndex.length = newCap;
    taskIdByIndex.fill(-1, oldCap);
    deferredByIndex.length = newCap;

    for (let i = newCap - 1; i >= oldCap; --i) {
      freeStack[freeTop++] = i;
    }
    return freeStack[--freeTop]!;
  }

  function processLoop(fromMicro = false) {
    let processed = 0;
    while (processed < batchLimit) {
      const maybeIndex = pendingQueue.shiftNoClear();
      if (maybeIndex === undefined) break;
      const index = maybeIndex | 0;
      if (stateByIndex[index] !== SlotStateMacro.Pending) continue;
      const taskID = taskIdByIndex[index];

      try {
        const args = argsByIndex[index];
        const fnId = fnByIndex[index];
        const res = runners[fnId]!(args);
        if (!(res instanceof Promise)) {
          settleIfCurrent(index, taskID, false, res);
          processed++;
          continue;
        }
        res.then(
          (value) => settleIfCurrent(index, taskID, false, value),
          (err) => settleIfCurrent(index, taskID, true, err),
        );
        processed++;
      } catch (err) {
        settleIfCurrent(index, taskID, true, err);
        processed++;
      }
    }

    if (hasPending()) {
      if (fromMicro) {
        scheduleMacro();
      } else {
        post2(null);
      }
      return;
    }

    if (!fromMicro) {
      isInMacro = false;
    }
  }

  function runMicroLoop() {
    if (!isInMicro) return;
    processLoop(true);
    isInMicro = false;
  }

  function cleanup(index: number) {
    working--;
    stateByIndex[index] = SlotStateMacro.Free;
    fnByIndex[index] = 0;
    taskIdByIndex[index] = -1;
    argsByIndex[index] = undefined;
    deferredByIndex[index] = undefined;
    freeStack[freeTop++] = index;
    if (working === 0) isInMacro = false;
  }

  const call = ({ fnNumber }: WorkerCall) => (args: unknown) => {
    const taskID = genTaskID();
    const deferred = withResolvers<unknown>();

    const index = allocIndex();
    taskIdByIndex[index] = taskID;
    argsByIndex[index] = args;
    fnByIndex[index] = fnNumber | 0;
    deferredByIndex[index] = deferred;
    stateByIndex[index] = SlotStateMacro.Pending;
    working++;

    if (args instanceof Promise) {
      args.then(
        (value) => {
          if (taskIdByIndex[index] !== taskID) return;
          argsByIndex[index] = value;
          enqueueIfCurrent(index, taskID);
        },
        (err) => settleIfCurrent(index, taskID, true, err),
      );
    } else {
      enqueue(index);
    }

    return deferred.promise;
  };
  //@ts-ignore
  port1.onmessage = () => processLoop(false);

  return {
    kills: async () => {
      for (let index = 0; index < stateByIndex.length; index++) {
        if (stateByIndex[index] !== SlotStateMacro.Pending) continue;
        try {
          deferredByIndex[index]?.reject("Thread closed");
        } catch {
        }
      }
      //@ts-ignore
      port1.onmessage = null;
      port1.close();
      //@ts-ignore
      port2.onmessage = null;
      port2.close();
      pendingQueue.clear();
      freeTop = 0;
      freeStack.length = 0;
      argsByIndex.fill(undefined);
      taskIdByIndex.fill(-1);
      deferredByIndex.fill(undefined);
      fnByIndex.fill(0);
      stateByIndex.fill(SlotStateMacro.Free);
      working = 0;
      isInMacro = false;
      isInMicro = false;
    },
    call,
    txIdle: () => working === 0,
  } as const;
};
