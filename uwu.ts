import {  isMain, task } from "./knitting.ts";

export const world = task({
  f: (args:string) => args  + " world" ,
}).createPool();

if (isMain) 
  world.call("hello")
  .then(console.log)
  .finally(world.shutdown);


