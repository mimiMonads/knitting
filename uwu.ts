import {  isMain, task } from "./knitting.ts";

export const world = task({
  f: async (args:string) => args  + " world" ,
}).createPool();

if (isMain) {
  await world.call("hello")
  .then(console.log)
  .finally(world.shutdown);
}

