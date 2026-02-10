import type { TaskTimeout, WorkerCall, tasks } from "../types.ts";
import { MessageChannel } from "node:worker_threads";
import { withResolvers } from "../common/with-resolvers.ts";

type TaskID = number;
type FunctionID = number;

interface Deferred {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (v: unknown) => void;
}

const enum SlotStateMacro {
  Free = -1,
  Pending = 0,
}

const enum SlotPos {
  TaskID = 0,
  Args = 1,
  FunctionID = 2,
  _Unused = 3,
  State = 4,
}

type SlotMacro = [
  TaskID,
  unknown,
  FunctionID,
  unknown,
  SlotStateMacro,
];

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
  promise: PromiseLike<unknown>,
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
  const funcs = entries.map((p) => p.f as (args: unknown) => unknown);
  const timeouts = entries.map((p) => normalizeTimeout(p.timeout));

  const initCap = 16;
  const newSlot = (): SlotMacro => [0, null, 0, null, SlotStateMacro.Free];
  const queue: SlotMacro[] = Array.from({ length: initCap }, newSlot);
  let stateArr = new Int8Array(initCap).fill(SlotStateMacro.Free);
  const freeStack: number[] = [];
  for (let i = initCap - 1; i >= 0; --i) freeStack.push(i);
  const pendingQueue: number[] = [];
  let pendingHead = 0;

  const promisesMap = new Map<TaskID, Deferred>();
  let working = 0;
  let isInMacro = false;
  const batchLimit = Number.isFinite(batchSize)
    ? Math.max(1, Math.floor(batchSize ?? 1))
    : Number.POSITIVE_INFINITY;

  const channel = new MessageChannel();
  const port1 = channel.port1;
  const port2 = channel.port2;
  const post2 = port2.postMessage.bind(port2);
  //@ts-ignore
  port1.onmessage = processLoop;

  const hasPending = () => pendingHead < pendingQueue.length;
  const isThenable = (value: unknown): value is PromiseLike<unknown> => {
    if (value == null) return false;
    const type = typeof value;
    if (type !== "object" && type !== "function") return false;
    return typeof (value as { then?: unknown }).then === "function";
  };

  function allocIndex(): number {
    if (freeStack.length) return freeStack.pop()!;

    // grow ×2
    const oldCap = queue.length;
    const newCap = oldCap * 2;
    for (let i = oldCap; i < newCap; ++i) {
      queue.push(newSlot());
      freeStack.push(i);
    }
    const newStates = new Int8Array(newCap);
    newStates.set(stateArr);
    newStates.fill(SlotStateMacro.Free, oldCap);
    stateArr = newStates;
    return freeStack.pop()!;
  }

  function processLoop() {
    let processed = 0;
    while (hasPending() && processed < batchLimit) {
      const index = pendingQueue[pendingHead++]!;
      if (pendingHead === pendingQueue.length) {
        pendingQueue.length = 0;
        pendingHead = 0;
      }
      const slot = queue[index];
      const settle = (
        isError: boolean,
        value: unknown,
      ) => {
        const taskID = slot[SlotPos.TaskID];
        if (isError) {
          promisesMap.get(taskID)?.reject(value);
        } else {
          promisesMap.get(taskID)?.resolve(value);
        }
        cleanup(index);
      };

      try {
        const args = slot[SlotPos.Args];
        if (isThenable(args)) {
          Promise.resolve(args).then(
            (value) => {
              slot[SlotPos.Args] = value;
              pendingQueue.push(index);
              if (!isInMacro) send();
            },
            (err) => settle(true, err),
          );
          processed++;
          continue;
        }
        const fnId = slot[SlotPos.FunctionID];
        const res = funcs[fnId](args);
        if (!isThenable(res)) {
          settle(false, res);
          processed++;
          continue;
        }
        const timeout = timeouts[fnId];
        const pending = timeout ? raceTimeout(res, timeout) : res;
        pending.then(
          (value) => settle(false, value),
          (err) => settle(true, err),
        );
        processed++;
      } catch (err) {
        settle(true, err);
        processed++;
      }
    }

    if (hasPending()) {
      post2(null);
      return;
    }

    isInMacro = false;
  }

  function cleanup(index: number) {
    const slot = queue[index];
    const taskID = slot[SlotPos.TaskID];
    working--;
    slot[SlotPos.State] = SlotStateMacro.Free;
    stateArr[index] = SlotStateMacro.Free;
    freeStack.push(index);
    promisesMap.delete(taskID);
    if (working === 0) isInMacro = false;
  }

  const call = ({ fnNumber }: WorkerCall) => (args: unknown) => {
    const taskID = genTaskID();
    const deferred = withResolvers();
    promisesMap.set(taskID, deferred);

    const index = allocIndex();
    const slot = queue[index];
    slot[SlotPos.TaskID] = taskID;
    slot[SlotPos.Args] = args;
    slot[SlotPos.FunctionID] = fnNumber;
    slot[SlotPos.State] = SlotStateMacro.Pending;
    stateArr[index] = SlotStateMacro.Pending;
    working++;

    const enqueue = () => {
      pendingQueue.push(index);
      if (!isInMacro) send();
    };

    if (isThenable(args)) {
      Promise.resolve(args).then(
        (value) => {
          slot[SlotPos.Args] = value;
          enqueue();
        },
        (err) => {
          deferred.reject(err);
          cleanup(index);
        },
      );
    } else {
      enqueue();
    }

    return deferred.promise;
  };

  const send = () => {
    if (working === 0 || isInMacro) return;
    isInMacro = true;
    post2(null);
  };

  return {
    kills: () => {
      //@ts-ignore
      port1.onmessage = null;
      port1.close();
      //@ts-ignore
      port2.onmessage = null;
      port2.close();
      pendingQueue.length = 0;
      pendingHead = 0;
      freeStack.length = 0;
      promisesMap.clear();
      stateArr.fill(SlotStateMacro.Free);
    },
    call,
    txIdle: () => working === 0,
  } as const;
};
