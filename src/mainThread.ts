import type { Composed, FixedPoints } from "./taskApi.ts";
import { type CallFunction } from "./threadManager.ts";

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

export const createMainThread = ({
  fixedPoints,
  genTaskID,
}: {
  fixedPoints: FixedPoints;
  genTaskID: () => number;
}) => {
  const funcs = Object.values(fixedPoints)
    .sort((a, b) => a.id - b.id)
    .map((p) => p.f as (...args: any[]) => Promise<any>);

  const initCap = 16;
  const newSlot = (): SlotMacro => [0, null, 0, null, SlotStateMacro.Free];
  const queue: SlotMacro[] = Array.from({ length: initCap }, newSlot);
  let stateArr = new Int8Array(initCap).fill(SlotStateMacro.Free);
  const freeStack: number[] = [];
  for (let i = initCap - 1; i >= 0; --i) freeStack.push(i);
  const pendingQueue: number[] = [];

  const promisesMap = new Map<TaskID, Deferred>();
  let working = 0;
  let isInMacro = false;

  const channel = new MessageChannel();
  channel.port1.onmessage = processNext;

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

  async function processNext() {
    if (!pendingQueue.length) return;
    const index = pendingQueue.shift()!;
    const slot = queue[index];
    try {
      const res = await funcs[slot[SlotPos.FunctionID]](slot[SlotPos.Args]);
      promisesMap.get(slot[SlotPos.TaskID])?.resolve(res);
    } catch (err) {
      promisesMap.get(slot[SlotPos.TaskID])?.reject(err);
    } finally {
      cleanup(index);
    }
    if (working > 0) channel.port2.postMessage(null);
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

  const callFunction = ({ fnNumber }: CallFunction) => (args: unknown) => {
    const taskID = genTaskID();
    const deferred = Promise.withResolvers();
    promisesMap.set(taskID, deferred);

    const index = allocIndex();
    const slot = queue[index];
    slot[SlotPos.TaskID] = taskID;
    slot[SlotPos.Args] = args;
    slot[SlotPos.FunctionID] = fnNumber;
    slot[SlotPos.State] = SlotStateMacro.Pending;
    stateArr[index] = SlotStateMacro.Pending;
    pendingQueue.push(index);
    working++;

    // Start macro‑chain if idle
    if (!isInMacro) send();

    return deferred.promise;
  };

  const send = () => {
    if (working === 0 || isInMacro) return;
    isInMacro = true;
    channel.port2.postMessage(null);
  };

  return {
    kills: () => {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.onmessage = null;
      channel.port2.close();
      pendingQueue.length = 0;
      freeStack.length = 0;
      promisesMap.clear();
      stateArr.fill(SlotStateMacro.Free);
    },
    callFunction,
    send,
    hasEverythingBeenSent: () => working === 0,
    fastCalling: (cf: CallFunction) => {
      const fn = callFunction(cf);
      return (a: unknown) => {
        const p = fn(a);
        if (!isInMacro) send();
        return p;
      };
    },
  } as const;
};
