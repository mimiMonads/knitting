import { PayloadType } from "../types.ts";
import { makeTask, TaskIndex, type Task } from "../memory/lock.ts";

const PLACE_HOLDER = (_?: unknown) => {
  throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
};

export const newSlotNoIndex = () => {
  const task = makeTask() as Task;
  task[TaskIndex.FuntionID] = 0;
  task[TaskIndex.ID] = 0;
  task.value = undefined;
  task.payloadType = PayloadType.UNREACHABLE;
  task.resolve = PLACE_HOLDER;
  task.reject = PLACE_HOLDER;
  return task;
};

