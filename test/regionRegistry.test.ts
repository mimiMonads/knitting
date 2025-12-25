import { assertEquals } from "jsr:@std/assert";
import { register } from "../src/memory/regionRegistry.ts";
import { Lock, makeTask, TaskIndex } from "../src/memory/lock.ts";



// AI Written needs review
const align64 = (n: number) => (n + 63) & ~63;

const makeRegistry = () =>
  register({
    lockSector: new SharedArrayBuffer(
      Lock.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    ),
  });

const allocAndSync = (registry: ReturnType<typeof makeRegistry>, size: number) => {
  const task = makeTask();
  task[TaskIndex.PayloadLen] = size;
  registry.allocTask(task);
  Atomics.store(registry.workerBits, 0, registry.hostBits[0]);
  return task;
};

Deno.test("allocTask assigns start for first two tasks and toggles host bits", () => {
  const registry = makeRegistry();

  const first = allocAndSync(registry, 1);
  assertEquals(first[TaskIndex.Start], 0);
  assertEquals(registry.hostBits[0], 1);

  const second = allocAndSync(registry, 70);
  assertEquals(second[TaskIndex.Start], align64(1));
  assertEquals(registry.hostBits[0], 3);
});

Deno.test("allocTask appends at end when no gap is found", () => {
  const registry = makeRegistry();

  allocAndSync(registry, 1);
  const second = allocAndSync(registry, 70);
  const third = allocAndSync(registry, 2);

  const expectedThirdStart = align64(1) + align64(70);

  assertEquals(second[TaskIndex.Start], align64(1));
  assertEquals(third[TaskIndex.Start], expectedThirdStart);
  assertEquals(registry.hostBits[0], 7);
});

Deno.test("allocTask keeps 64-byte alignment and monotonic offsets", () => {
  const registry = makeRegistry();
  const sizes = [0, 1, 63, 64, 65, 127, 128, 255, 256];

  let expectedStart = 0;

  for (const size of sizes) {
    const task = allocAndSync(registry, size);
    assertEquals(task[TaskIndex.Start], expectedStart);
    assertEquals(task[TaskIndex.Start] % 64, 0);
    expectedStart += align64(size);
  }
});

Deno.test("allocTask is a no-op when the table is full", () => {
  const registry = makeRegistry();
  const size = 1;

  let expectedStart = 0;
  for (let i = 0; i < Lock.slots; i++) {
    const task = allocAndSync(registry, size);
    assertEquals(task[TaskIndex.Start], expectedStart);
    expectedStart += align64(size);
  }

  assertEquals(registry.hostBits[0] >>> 0, 0xFFFFFFFF);

  const before = registry.hostBits[0];
  const extra = makeTask();
  extra[TaskIndex.PayloadLen] = size;
  extra[TaskIndex.Start] = 0xDEADBEEF;

  registry.allocTask(extra);
  Atomics.store(registry.workerBits, 0, registry.hostBits[0]);

  assertEquals(extra[TaskIndex.Start], 0xDEADBEEF);
  assertEquals(registry.hostBits[0], before);
});
