import { assertEquals } from "jsr:@std/assert";
import { register } from "../src/memory/regionRegistry.ts";
import { Lock, makeTask, TaskIndex } from "../src/memory/lock.ts";



// AI Written needs review
// const align64 = (n: number) => (n + 63) & ~63;

const makeRegistry = () =>
  register({
    lockSector: new SharedArrayBuffer(
      Lock.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    ),
  });

const track64andIndex = (startAndIndex: number) => [ startAndIndex >>> 6 , startAndIndex & 31 ]
const allocAndSync = (registry: ReturnType<typeof makeRegistry>, size: number) => {
  const task = makeTask();
  task[TaskIndex.PayloadLen] = size;
  registry.allocTask(task);
  Atomics.store(registry.workerBits, 0, registry.hostBits[0]);
  return task;
};



Deno.test("check packing in startAndIndexToArray", () => {
  const registry = makeRegistry();
  const sizes = [64, 43 , 152 , 54];

  const result = [[0,0] , ...sizes.map( (_,i,a) => {

    // add them together and index [postion + padding , index]
    const  val = a.slice(0,i + 1).reduce((acc,c) => acc+ ((64 + c) >>> 6), 0) 
    return [val, ++i]
  }).slice(0,-1)] 

  for (const size of sizes) {
    allocAndSync(registry, size);
  }


  assertEquals(
    registry
    .startAndIndexToArray(sizes.length)
    .map(track64andIndex),
       result
      );

 
});

Deno.test("check packing in startAndIndexToArray", () => {
  const registry = makeRegistry();
  const sizes = [64, 64 , 64 , 64, 64 , 64];

  const result = [[0,0] , ...sizes.map( (_,i,a) => {

    // add them together and index [postion + padding , index]
    const  val = a.slice(0,i + 1).reduce((acc,c) => acc+ ((64 + c) >>> 6), 0) 
    return [val, ++i]
  }).slice(0,-1)] 

  for (const size of sizes) {
    allocAndSync(registry, size);
  }



  assertEquals(
    registry
    .startAndIndexToArray(sizes.length )
    .map(track64andIndex),
       result
      );

  registry.free(1)
  //registry.free(2)
  registry.updateTable()
  //allocAndSync(registry, 10);
  // result.splice(1,2)

  
  assertEquals(
    registry
    .startAndIndexToArray(sizes.length - 1)
    .map(track64andIndex),
       []
      );

 
});

Deno.test("check Start from Task", () => {
  const registry = makeRegistry();
  const sizes = [64, 453 , 64 , 64];
  const values = []

  const result = sizes.reduce( (acc,v) => (
    // reduce and adding padding and  >>> 6
    acc.push((acc[acc.length - 1] + v + 64) & ~63 ),
    acc ), 
  [0]).slice(0,-1)

  for (const size of sizes) {
    values.push(allocAndSync(registry, size)[TaskIndex.Start]);
  }


  assertEquals( values, result  );

 
});



