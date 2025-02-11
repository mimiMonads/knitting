import { assertEquals } from "jsr:@std/assert";
import { createContext } from "../src/main.ts";
import { fixedPoint, toListAndIds } from "../src/fixpoint.ts";
import { signalsForWorker } from "../src/signal.ts";

export const a = fixedPoint({
  args: "uint8",
  f: async (a) => a,
});

const unitArrayOne = Uint8Array.from([1, 2, 3, 4]);
const unitArrayTwo = Uint8Array.from([8, 7, 6, 5]);
const unitArrayThree = Uint8Array.from([9, 10, 11, 12]);

//@ts-ignore
const VALUE = Uint8Array.from("Hello");

Deno.test("fixpoint", async () => {
  assertEquals(
    a.importedFrom.includes("/test/core.test.ts"),
    true,
  );
});

Deno.test("Using core one argument", async () => {
  const promisesMap = new Map();
  const { ids, list } = toListAndIds({ a });
  const ctx = createContext({
    promisesMap,
    ids,
    list,
  });
  const num = ctx.queue.add(192)(0)(unitArrayOne);
  ctx.isActive();
  const res1 = await ctx.queue.awaits(num)
    .finally(
      ctx.kills,
    );

  assertEquals(
    res1,
    unitArrayOne,
  );
});

Deno.test("Using core wit multiple arguments", async () => {
  // Init signals
  const size = 200000;
  const sab = {
    size,
    sharedSab: new SharedArrayBuffer(size),
  };
  const signal = signalsForWorker(sab);

  // Init context
  const promisesMap = new Map();
  const { ids, list } = toListAndIds({ a });
  const ctx = createContext({
    promisesMap,
    ids,
    list,
    sab,
  });

  // Adding request to the queue
  const arr = [
    ctx.queue.add(192)(0)(unitArrayOne),
    ctx.queue.add(192)(0)(unitArrayTwo),
    ctx.queue.add(192)(0)(unitArrayThree),
  ];

  // Run
  ctx.isActive();

  // Resolving
  const res = await ctx.awaitArray(arr)
    .then((res) => {
      return res;
    })
    .finally(
      ctx.kills,
    );

  
  assertEquals(
    res,
    [unitArrayOne, unitArrayTwo, unitArrayThree],
  );

});
