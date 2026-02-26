
import { createPool, isMain, task } from "./knitting.ts";

export const add = task({
  f: (_ : [number,number]):number => 0,
  href: "https://knittingdocs.netlify.app/example-task.mjs"
});

const pool = createPool({
 
})({
  add
});

if (isMain) {
  console.log("docs say :", await pool.call.add([3,4]));
  await pool.shutdown();
}
