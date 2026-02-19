import assert from "node:assert/strict";
import test from "node:test";
const assertEquals: (actual: unknown, expected: unknown) => void =
  (actual, expected) => {
    assert.deepStrictEqual(actual, expected);
  };
import { register } from "../src/memory/regionRegistry.ts";
import {
  LOCK_SECTOR_BYTE_LENGTH,
  makeTask,
  TaskIndex,
} from "../src/memory/lock.ts";


const align64 = (n: number) => (n + 63) & ~63;

const makeRegistry = () =>
  register({
    lockSector: new SharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH),
  });

const track64andIndex = (startAndIndex: number) => [ startAndIndex >>> 6 , startAndIndex & 31 ]
const allocNoSync = (registry: ReturnType<typeof makeRegistry>, size: number) => {
  const task = makeTask();
  task[TaskIndex.PayloadLen] = size;
  registry.allocTask(task);
  return task;
};
const expectedStartAndIndex = (sizes: number[]) =>
  [[0,0] , ...sizes.map( (_,i,a) => {

    const  val = a.slice(0,i + 1).reduce((acc,c) => acc+ (align64(c) >>> 6), 0)
    return [val, ++i]
  }).slice(0,-1)]



test("check packing in startAndIndexToArray", () => {
  const registry = makeRegistry();
  const sizes = [634, 43 , 152 , 54];

  const result = [[0,0] , ...sizes.map( (_,i,a) => {

    // add them together and index [position + padding , index]
    const  val = a.slice(0,i + 1).reduce((acc,c) => acc+ (align64(c) >>> 6), 0) 
    return [val, ++i]
  }).slice(0,-1)] 

  for (const size of sizes) {
    allocNoSync(registry, size);
  }


  assertEquals(
    registry
    .startAndIndexToArray(sizes.length)
    .map(track64andIndex)
    , result
      );

 
});

test("updateTable delete front", () => {
  const registry = makeRegistry();
  const sizes = [634, 64 , 64 , 64, 64 , 64];
  const toBeDeletedFront = 2

  const result = [[0,0] , ...sizes.map( (_,i,a) => {

    // add them together and index [position + padding , index]
    const  val = a.slice(0,i + 1).reduce((acc,c) => acc+ (align64(c) >>> 6), 0) 
    return [val, ++i]
  }).slice(0,-1)] 

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  assertEquals(
    registry
    .startAndIndexToArray(sizes.length )
    .map(track64andIndex),
       result
      );

  registry.free(0)
  registry.free(1)
  registry.updateTable()
  result.splice(0,toBeDeletedFront)

  
  assertEquals(
    registry
    .startAndIndexToArray(sizes.length - toBeDeletedFront)
    .map(track64andIndex),
       result
      );
});


test("updateTable delete Back", () => {
  const registry = makeRegistry();
  const sizes = [64, 64 , 64 , 64, 64 , 64];
  const toBeDeletedBack = 2

  const result = [[0,0] , ...sizes.map( (_,i,a) => {

    // add them together and index [position + padding , index]
    const  val = a.slice(0,i + 1).reduce((acc,c) => acc+ (align64(c) >>> 6), 0) 
    return [val, ++i]
  }).slice(0,-1)] 

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  assertEquals(
    registry
    .startAndIndexToArray(sizes.length )
    .map(track64andIndex),
       result
      );

  registry.free(4)
  registry.free(5)
  registry.updateTable()
  result.splice(-toBeDeletedBack)

  
  assertEquals(
    registry
    .startAndIndexToArray(sizes.length - toBeDeletedBack)
    .map(track64andIndex),
       result
      );
});


test("updateTable delete middle", () => {
  const registry = makeRegistry();
  const sizes = [64, 64 , 64 , 64, 64 , 64];
  const toBeDeletedBack = 2

  const result = [[0,0] , ...sizes.map( (_,i,a) => {

    // add them together and index [position + padding , index]
    const  val = a.slice(0,i + 1).reduce((acc,c) => acc+ (align64(c) >>> 6), 0) 
    return [val, ++i]
  }).slice(0,-1)] 

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  assertEquals(
    registry
    .startAndIndexToArray(sizes.length )
    .map(track64andIndex),
       result
      );

  registry.free(1)
  registry.free(2)
  registry.updateTable()
  result.splice(1,toBeDeletedBack)

  
  assertEquals(
    registry
    .startAndIndexToArray(sizes.length - toBeDeletedBack)
    .map(track64andIndex),
       result
      );
});

test("check Start from Task", () => {
  const registry = makeRegistry();
  const sizes = [64, 453 , 64 , 64];
  const values = []

  const result = sizes.reduce( (acc,v) => (
    // reduce and adding padding and  >>> 6
    acc.push(acc[acc.length - 1] + align64(v)),
    acc ), 
  [0]).slice(0,-1)

  for (const size of sizes) {
    values.push(allocNoSync(registry, size)[TaskIndex.Start]);
  }


  assertEquals( values, result  );

 
});

test("packing boundary at payload size 63", () => {
  const registry = makeRegistry();
  const sizes = [63, 1];

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  assertEquals(
    registry
    .startAndIndexToArray(sizes.length)
    .map(track64andIndex),
     expectedStartAndIndex(sizes)
      );
});

test("updateTable clears freed index >= 5", () => {
  const registry = makeRegistry();
  const sizes = Array.from({ length: 7 }, () => 64);

  for (const size of sizes) {
    allocNoSync(registry, size);
  }

  registry.free(5);
  registry.updateTable();

  const result = expectedStartAndIndex(sizes);
  result.splice(5, 1);

  assertEquals(
    registry
    .startAndIndexToArray(sizes.length - 1)
    .map(track64andIndex),
       result
      );
});

test("allocTask reuses freed gap", () => {
  const registry = makeRegistry();
  const sizes = [64, 64, 64];
  const tasks = sizes.map((size) => allocNoSync(registry, size));
  const freedStart = tasks[1][TaskIndex.Start];

  registry.free(1);
  registry.updateTable();

  const task = makeTask();
  task[TaskIndex.PayloadLen] = 64;
  registry.allocTask(task);

  assertEquals(task[TaskIndex.Start], freedStart);
});

test("periodic compaction can reuse a freed gap during allocTask", () => {
  const registry = makeRegistry();
  const sizes = [64, 64, 64];
  const tasks = sizes.map((size) => allocNoSync(registry, size));
  const freedStart = tasks[1][TaskIndex.Start];

  registry.free(1);

  const task = makeTask();
  task[TaskIndex.PayloadLen] = 64;
  registry.allocTask(task);

  assertEquals(task[TaskIndex.Start], freedStart);
});

test("updateTable reuses freed slots in gaps and at start", () => {
  const registry = makeRegistry();
  const tasks = [64, 64, 64, 64].map((size) => allocNoSync(registry, size));

  registry.free(0);
  registry.free(2);
  registry.updateTable();

  const first = makeTask();
  first[TaskIndex.PayloadLen] = 64;
  registry.allocTask(first);

  const second = makeTask();
  second[TaskIndex.PayloadLen] = 64;
  registry.allocTask(second);

  assertEquals(first[TaskIndex.Start], 0);
  assertEquals(second[TaskIndex.Start], tasks[1][TaskIndex.Start] + 64);
});

test("updateTable resets usedBits when all slots freed", () => {
  const registry = makeRegistry();
  allocNoSync(registry, 64);
  allocNoSync(registry, 64);

  registry.free(0);
  registry.free(1);
  registry.updateTable();

  const task = makeTask();
  task[TaskIndex.PayloadLen] = 64;
  registry.allocTask(task);

  assertEquals(task[TaskIndex.Start], 0);
});

test("setSlotLength shrinks slot and exposes gap for next allocation", () => {
  const registry = makeRegistry();

  const first = allocNoSync(registry, 700 * 3);
  const second = allocNoSync(registry, 64);

  assertEquals(second[TaskIndex.Start], align64(700 * 3));
  assertEquals(registry.setSlotLength(first[TaskIndex.slotBuffer], 700), true);

  const third = makeTask();
  third[TaskIndex.PayloadLen] = 128;
  registry.allocTask(third);

  assertEquals(third[TaskIndex.Start], align64(700));
});

test("setSlotLength rejects growing a slot", () => {
  const registry = makeRegistry();
  const task = allocNoSync(registry, 64);

  assertEquals(registry.setSlotLength(task[TaskIndex.slotBuffer], 256), false);
});
