import { assertEquals } from "jsr:@std/assert";
import { createContext } from "../src/threadManager.ts";
import { fixedPoint, toListAndIds } from "../src/taskApi.ts";
import { signalsForWorker } from "../src/signals.ts";

export const a = fixedPoint({
  args: "uint8",
  f: async (a) => a,
});

const unitArrayOne = Uint8Array.from([1, 2, 3, 4]);
const unitArrayTwo = Uint8Array.from([8, 7, 6, 5]);
const unitArrayThree = Uint8Array.from([9, 10, 11, 12]);

//@ts-ignore -> This is valid btw
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
    thread: 0,
  });
  const num = ctx.queue.enqueue(0)(unitArrayOne);
  //@ts-ignore
  ctx.isActive();
  const res1 = await ctx.queue.awaits(num)!
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
    thread: 0,
  });

  // enqueueing request to the queue
  const arr = [
    ctx.queue.enqueue(0)(unitArrayOne),
    ctx.queue.enqueue(0)(unitArrayTwo),
    ctx.queue.enqueue(0)(unitArrayThree),
  ];

  // Run
  //@ts-ignore
  ctx.isActive();

  // Resolving
  const res = await ctx.awaitArray(arr)
    .finally(ctx.kills);

  assertEquals(
    res,
    [unitArrayOne, unitArrayTwo, unitArrayThree],
  );
});
