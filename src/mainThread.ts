import type { Composed, FixedPoints, Serializable } from "./taskApi.ts";
import { type CallFunction } from "./threadManager.ts";

type TaskID = number;
type FunctionID = number;
type WorkerResponse<T extends Serializable = Uint8Array> = T;

type PromiseMap = Map<
  TaskID,
  {
    promise: Promise<any>;
    resolve: (val: any) => void;
    reject: (val: any) => void;
  }
>;

enum SlotState {
  Free = -1,
  Pending = 0,
}

enum Position {
  TaskID = 0,
  Args = 1,
  FunctionID = 2,
  UnUsed = 3,
  SlotState = 4,
}

type Slot = [
  number,
  unknown,
  number,
  unknown,
  SlotState,
];

export const createMainThread = ({
  fixedPoints,
  genTaskID,
}: { fixedPoints: FixedPoints; genTaskID: () => number }) => {
  // We do this to ensure that the function taken always have the same order
  const ArrayOfPoints = Object.keys(fixedPoints)
    .reduce((acc, x) => (
      acc.push(fixedPoints[x]), acc
    ), [] as Composed[])
    .sort((a, b) => a.id - b.id)
    .map((points) => points.f);

  const promisesMap: PromiseMap = new Map();

  // This pool is meant to be dynamic `5` is just a random value
  const queue = Array.from(
    { length: 10 },
    () => [0, null, 0, null, SlotState.Free] as Slot,
  );

  const channel = new MessageChannel();

  // Helps to avoid a O(n) reading slots
  let working = 0;

  let isInMacro: boolean = false;

  // It would be resolve in the macroqueue
  const runSlot = async () => {
    for (let index = 0; index < queue.length; index++) {
      // Checks for a pending slot and it breaks after it
      // This force it to have to await for another macroqueue cycle
      if (queue[index][Position.SlotState] === SlotState.Pending) {
        try {
          const slot = queue[index];
          const result = await ArrayOfPoints[slot[Position.FunctionID]](
            slot[Position.Args],
          );
          promisesMap.get(slot[Position.TaskID])?.resolve(result);
        } catch (error) {
          promisesMap.get(queue[index][Position.TaskID])?.reject(error);
        }

        break;
      }
    }
  };
  const open = () => {
    channel.port1.onmessage = runSlot;
  };

  // Opens since the start
  open();

  // It is killed by a higer order function
  const kills = () => {
    console.log("this messages displats");
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.onmessage = null;
    channel.port2.close();
  };

  // This function also chains till queue is free
  const cleanup = (slot: Slot, taskID: TaskID) => {
    working--;
    slot[Position.SlotState] = SlotState.Free;
    promisesMap.delete(taskID);
    // Chains
    if (working > 0) channel.port2.postMessage(null);
    // Exits the chain
    else isInMacro = false;
  };

  const callFunction = ({ fnNumber }: CallFunction) => (args: unknown) => {
    let idx = -1;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i][Position.SlotState] === SlotState.Free) {
        idx = i;
        break;
      }
    }

    const taskID = genTaskID();
    const deferred = Promise.withResolvers<WorkerResponse>();
    promisesMap.set(taskID, deferred);

    working++;

    if (idx !== -1) {
      const slot = queue[idx];
      slot[Position.TaskID] = taskID;
      slot[Position.Args] = args as Uint8Array;
      slot[Position.FunctionID] = fnNumber;
      slot[Position.SlotState] = SlotState.Pending;

      return deferred.promise.finally(() => cleanup(slot, taskID));
    } else {
      // We are using the returned length of the array reason why we need to substract one
      const slot = queue[
        queue.push([
          taskID,
          args as Uint8Array,
          fnNumber,
          null,
          SlotState.Pending,
        ]) - 1
      ];

      return deferred.promise.finally(() => cleanup(slot, taskID));
    }
  };

  const hasEverythingBeenSent = () => working === 0;

  const send = () => {
    if (working === 0) {
      return;
    }

    if (isInMacro === true) {
      return;
    }
    // Starts the chain
    isInMacro = true;
    channel.port2.postMessage(null);
  };

  return {
    kills,
    callFunction,
    send,
    hasEverythingBeenSent,
    fastCalling: (ar: CallFunction) => {
      const composed = callFunction(ar);

      return (args: unknown) => {
        const deferred = composed(args);

        // Check if is an element in the macroqueue
        if (isInMacro === false) send();

        return deferred;
      };
    },
  };
};
