import {  isMain, task , createPool} from "./knitting.ts";


export const addOne = task<Promise<number> | number, number>({
  f: (n) => {
    n = n + 1 // n is already awaited here
    return Promise.resolve(n)// retrun is a Promise of n
  }, 
});

const pool = createPool({ threads: 1 })({ addOne });

if(isMain){
  // Promise input is accepted and already solved.
const result = await pool.call.addOne(Promise.resolve(41));
console.log(result)
// result: number (42)
}