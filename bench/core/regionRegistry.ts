import { bench, group, run as mitataRun } from "mitata";
import { register } from "../src/memory/regionRegistry.ts";
import {
  LOCK_SECTOR_BYTE_LENGTH,
  makeTask,
  TaskIndex,
} from "../src/memory/lock.ts";
import { format, print } from "./ulti/json-parse.ts";

// make with AI, recheck later 

const makeRegistry = () =>
  register({
    lockSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
  });

const task = makeTask();
const allocAndSync = (registry: ReturnType<typeof makeRegistry>, size: number) => {
  task[TaskIndex.PayloadLen] = size;
  registry.allocTask(task);
  Atomics.store(registry.workerBits, 0, registry.hostBits[0]);
  return task;
};

const fill = (registry: ReturnType<typeof makeRegistry>, count: number, size: number) => {
  for (let i = 0; i < count; i++) {
    allocAndSync(registry, size);
  }
};

const registry = makeRegistry();
group("regionRegistry", () => {
  bench("allocTask append (16)", () => {

    fill(registry, 16, 64);
  });

  bench("allocTask reuse gap (free 2)", () => {

    fill(registry, 8, 64);
    registry.free(1);
    registry.free(2);
    registry.updateTable();
    allocAndSync(registry, 64);
  });

  bench("updateTable compact (free 6)", () => {

    fill(registry, 16, 64);
    registry.free(2);
    registry.free(4);
    registry.free(6);
    registry.free(8);
    registry.free(10);
    registry.free(12);
    registry.updateTable();
  });
});

await mitataRun({
  format,
  print,
});
