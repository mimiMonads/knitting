import { assertEquals } from "jsr:@std/assert";
import { createContext } from "../src/threadManager.ts";
import { fixedPoint, toListAndIds } from "../src/taskApi.ts";
import { signalsForWorker } from "../src/signals.ts";

export const a = fixedPoint({
  args: "uint8",
  retrun: "uint8",
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

Deno.test("Using core fastcalling", async () => {
  const promisesMap = new Map();
  const { ids, list } = toListAndIds({ a });
  const ctx = createContext({
    promisesMap,
    ids,
    list,
    thread: 0,
    fixedPoints: [
      {name: "a", ...a}
    ]
  });
  const fn = ctx.fastCalling({ fnNumber: 0 })(unitArrayOne);

  ctx.send();

  const res1 = await fn!
    .finally(
      ctx.kills,
    );

  assertEquals(
    res1,
    unitArrayOne,
  );
});

Deno.test("Using core  fastcalling wit multiple arguments", async () => {
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
    fixedPoints: {
      a,
    },
  });
  const composed = {
    fnNumber: 0,
  };

  // enqueueing request to the queue
  const arr = [
    ctx.fastCalling(composed)(unitArrayOne),
    ctx.fastCalling(composed)(unitArrayTwo),
    ctx.fastCalling(composed)(unitArrayThree),
  ];

  ctx.send();

  // Resolving
  const res = await Promise.all(arr)
    .finally(ctx.kills);

  assertEquals(
    res,
    [unitArrayOne, unitArrayTwo, unitArrayThree],
  );
});

Deno.test("Using core calling wit multiple arguments", async () => {
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
    fixedPoints: {
      a,
    },
  });
  const composed = {
    fnNumber: 0,
  };

  // enqueueing request to the queue
  const arr = [
    ctx.callFunction(composed)(unitArrayOne),
    ctx.callFunction(composed)(unitArrayTwo),
    ctx.callFunction(composed)(unitArrayThree),
  ];

  ctx.send();

  // Resolving
  const res = await Promise.all(arr)
    .finally(ctx.kills);

  assertEquals(
    res,
    [unitArrayOne, unitArrayTwo, unitArrayThree],
  );
});
