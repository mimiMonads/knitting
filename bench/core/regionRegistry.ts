import { bench, group, run as mitataRun } from "mitata";
import { register } from "../../src/memory/regionRegistry.ts";
import {
  LOCK_SECTOR_BYTE_LENGTH,
  makeTask,
  type Task,
  TaskIndex,
} from "../../src/memory/lock.ts";
import { format, print } from "../util/json-parse.ts";

const BASELINE_BYTES = new Uint8Array(8).byteLength;

const makeRegistry = () =>
  register({
    lockSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
  });

const makeSizedTasks = (count: number, size: number): Task[] =>
  Array.from({ length: count }, () => {
    const task = makeTask();
    task[TaskIndex.PayloadLen] = size;
    return task;
  });

const appendTasks = makeSizedTasks(16, BASELINE_BYTES);
const reuseGapTasks = makeSizedTasks(8, BASELINE_BYTES);
const compactTasks = makeSizedTasks(16, BASELINE_BYTES);
const recycleTasks = makeSizedTasks(16, BASELINE_BYTES);
const reuseGapTask = makeTask();
reuseGapTask[TaskIndex.PayloadLen] = BASELINE_BYTES;

const fill = (
  registry: ReturnType<typeof makeRegistry>,
  tasks: Task[],
) => {
  for (const task of tasks) {
    registry.allocTask(task);
  }
};

group(`regionRegistry atomic (${BASELINE_BYTES} B)`, () => {
  bench("allocTask append (16)", () => {
    fill(makeRegistry(), appendTasks);
  });

  bench("allocTask reuse gap (free 2)", () => {
    const registry = makeRegistry();
    fill(registry, reuseGapTasks);
    registry.free(1);
    registry.free(2);
    registry.updateTable();
    registry.allocTask(reuseGapTask);
  });

  bench("updateTable compact (free 6)", () => {
    const registry = makeRegistry();
    fill(registry, compactTasks);
    registry.free(2);
    registry.free(4);
    registry.free(6);
    registry.free(8);
    registry.free(10);
    registry.free(12);
    registry.updateTable();
  });

  // The path that used to be broken: allocate the table full, release every
  // slot, then allocate again. That second round can only succeed if the arena
  // reset detects that all tracked bits—not necessarily all 32 bits—are free.
  bench("arena recycle (fill 16, free all, refill)", () => {
    const registry = makeRegistry();
    fill(registry, recycleTasks);
    for (let slot = 0; slot < recycleTasks.length; slot++) {
      registry.free(slot);
    }
    fill(registry, recycleTasks);
  });
});

await mitataRun({
  format,
  print,
});
