import { assertEquals } from "jsr:@std/assert";
import { createPool, task } from "../knitting.ts";

// const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// let num = 0;

// export const justThrow = task({
//   f: async () => {
//     throw "Something broke in the register";
//   },
// });

// export const hello = task({
//   f: async () => num++,
// });

// Deno.test("FIFO", async () => {
//   const { shutdown, call } = createPool({})({ hello });

//   const toTest: number[] = [];
//   const fn = (n: number) => toTest.push(n);

//   const rightAnswer = Array.from({ length: 100 }, (_, i) => i);
//   const awaited = Array.from({ length: 100 }, () => call.hello().then(fn));

//   await Promise.all(awaited);
//   await shutdown();

//   assertEquals(toTest, rightAnswer);
// });

// export const delayed = task({
//   f: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)).then(() => ms),
// });

// Deno.test("Correct use of setTimeout", async () => {
//   const { shutdown, call } = createPool({})({ delayed });

//   const toTest: number[] = [];
//   const fn = (n: number) => toTest.push(n);
//   const length = 5;
//   const rightAnswer = Array.from({ length }, (_, i) => i);
//   const awaited = Array.from(
//     { length },
//     (_, i) => call.delayed(length - i).then(fn),
//   );

//   await Promise.all(awaited);
//   await shutdown();

//   assertEquals(toTest, rightAnswer);
// });
