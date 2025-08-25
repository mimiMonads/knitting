import { bench, group, run as mitataRun } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { terminateAllWorkers, toResolve } from "./postmessage/single.ts";
import { format, print } from "./ulti/json-parse.ts";
// ───────────────────────── fixed points ─────────────────────────
export const toNumber = fixedPoint({ f: async (a: number) => a });
export const toString = fixedPoint({ f: async (a: string) => a });
export const toBigInt = fixedPoint({ f: async (a: bigint) => a });
export const toBoolean = fixedPoint({ f: async (a: boolean) => a });
export const toVoid = fixedPoint({ f: async (_: void) => {} });
export const toObject = fixedPoint({ f: async (a: object) => a });

if (isMain) {
  const { callFunction, fastCallFunction, terminateAll, send } =
    createThreadPool({})({
      toNumber,
      toString,
      toBigInt,
      toBoolean,
      toVoid,
      toObject,
    });

  const sizes = [1, 10, 100];

  // helpers
  const runCF = async <T>(n: number, fn: () => Promise<T>) => {
    const promises = Array.from({ length: n }, fn);
    send(); // flush CF batch
    await Promise.all(promises);
  };
  const runFF = async <T>(n: number, fn: () => Promise<T>) => {
    await Promise.all(Array.from({ length: n }, fn));
  };
  const runClassic = async <T>(n: number, val: T) => {
    await Promise.all(Array.from({ length: n }, () => toResolve(val)));
  };

  const string = "helloWorld";
  const bigString = "helloWorld".repeat(100);
  const num = 77777;
  const min = -(2n ** 63n - 1n);
  const max = 2n ** 64n - 1n;
  const smallArray = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const bigArray = Array.from({ length: 500 }, (_, i) => i * Math.random());
  const obj = {
    number: 123,
    string: "helloWorld",
    nullable: null,
    arr: [1, 2, 3, 4, 5],
  };
  const bigObj = {
    users: Array.from({ length: 5 }, (_, i) => ({
      id: i,
      name: `User ${i}`,
      age: Math.floor(Math.random() * 80),
      tags: Array.from(
        { length: 10 },
        () => Math.random().toString(36).slice(2),
      ),
      address: {
        city: "Testville",
        zip: Math.floor(Math.random() * 90000 + 10000),
      },
    })),
  };

  Object.freeze(bigObj)


  group("knitting fast", () => {
    bench(`string -> (1)`, async () => {
      await fastCallFunction.toString(string);
    });
    bench(`large string -> (1)`, async () => {
      await fastCallFunction.toString(bigString);
    });
    bench(`number -> (1)`, async () => {
      await fastCallFunction.toNumber(num);
    });
    bench(
      `min bigint -> (1)`,
      async () => await fastCallFunction.toBigInt(min),
    );
    bench(
      `max bigint -> (1)`,
      async () => await fastCallFunction.toBigInt(max),
    );
    bench(
      `boolean true -> (1)`,
      async () => await fastCallFunction.toBoolean(true),
    );
    bench(
      `boolean false -> (1)`,
      async () => await fastCallFunction.toBoolean(false),
    );
    bench(`void -> (1)`, async () => await fastCallFunction.toVoid());
    bench(
      `small array -> (1)`,
      async () => await fastCallFunction.toObject(smallArray),
    );
    bench(
      `big Array -> (1)`,
      async () => await fastCallFunction.toObject(bigArray),
    );
    bench(`object -> (1)`, async () => await fastCallFunction.toObject(obj));
    bench(
      `big object -> (1)`,
      async () => await fastCallFunction.toObject(bigObj),
    );

    const firstRemoved = sizes.slice(1);

    for (const n of firstRemoved) {
      bench(`string -> (${n})`, async () => {
        await runFF(n, async () => fastCallFunction.toString(string));
      });
      bench(`large string -> (${n})`, async () => {
        await runFF(n, async () => fastCallFunction.toString(bigString));
      });
      bench(`number -> (${n})`, async () => {
        await runFF(n, async () => fastCallFunction.toNumber(num));
      });
      bench(
        `min bigint -> (${n})`,
        async () => await runFF(n, async () => fastCallFunction.toBigInt(min)),
      );

      bench(
        `max bigint -> (${n})`,
        async () => await runFF(n, async () => fastCallFunction.toBigInt(max)),
      );
      bench(
        `boolean true -> (${n})`,
        async () =>
          await runFF(n, async () => fastCallFunction.toBoolean(true)),
      );

      bench(
        `boolean false -> (${n})`,
        async () =>
          await runFF(n, async () => fastCallFunction.toBoolean(false)),
      );

      bench(
        `void -> (${n})`,
        async () => await runFF(n, async () => fastCallFunction.toVoid()),
      );
      bench(
        `small array -> (${n})`,
        async () =>
          await runFF(n, async () => fastCallFunction.toObject(smallArray)),
      );

      bench(
        `big Array -> (${n})`,
        async () =>
          await runFF(n, async () => fastCallFunction.toObject(bigArray)),
      );
      bench(
        `object -> (${n})`,
        async () => await runFF(n, async () => fastCallFunction.toObject(obj)),
      );
      bench(
        `big object -> (${n})`,
        async () =>
          await runFF(n, async () => fastCallFunction.toObject(bigObj)),
      );
    }
  });

  group("knitting", () => {
    for (const n of sizes) {
      bench(`string -> (${n})`, async () => {
        await runCF(n, async () => callFunction.toString(string));
      });
      bench(`large string -> (${n})`, async () => {
        await runCF(n, async () => callFunction.toString(bigString));
      });
      bench(`number -> (${n})`, async () => {
        await runCF(n, async () => callFunction.toNumber(num));
      });
      bench(
        `min bigint -> (${n})`,
        async () => await runCF(n, async () => callFunction.toBigInt(min)),
      );

      bench(
        `max bigint -> (${n})`,
        async () => await runCF(n, async () => callFunction.toBigInt(max)),
      );
      bench(
        `boolean true -> (${n})`,
        async () => await runCF(n, async () => callFunction.toBoolean(true)),
      );

      bench(
        `boolean false -> (${n})`,
        async () => await runCF(n, async () => callFunction.toBoolean(false)),
      );

      bench(
        `void -> (${n})`,
        async () => await runCF(n, async () => callFunction.toVoid()),
      );
      bench(
        `small array -> (${n})`,
        async () =>
          await runCF(n, async () => callFunction.toObject(smallArray)),
      );

      bench(
        `big Array -> (${n})`,
        async () => await runCF(n, async () => callFunction.toObject(bigArray)),
      );
      bench(
        `object -> (${n})`,
        async () => await runCF(n, async () => callFunction.toObject(obj)),
      );
      bench(
        `big object -> (${n})`,
        async () => await runCF(n, async () => callFunction.toObject(bigObj)),
      );
    }
  });

  group("worker", () => {
    for (const n of sizes) {
      bench(`string -> (${n})`, async () => {
        await runClassic(n, string);
      });
      bench(`large string -> (${n})`, async () => {
        await runClassic(n, bigString);
      });
      bench(`number -> (${n})`, async () => {
        await runClassic(n, num);
      });
      bench(`min bigint -> (${n})`, async () => await runClassic(n, min));

      bench(`max bigint -> (${n})`, async () => await runClassic(n, max));
      bench(`boolean true -> (${n})`, async () => await runClassic(n, true));

      bench(`boolean false -> (${n})`, async () => await runClassic(n, false));

      bench(`void -> (${n})`, async () => await runClassic(n, undefined));

      bench(
        `small array -> (${n})`,
        async () => await runClassic(n, smallArray),
      );

      bench(`big Array -> (${n})`, async () => await runClassic(n, bigArray));
      bench(`object -> (${n})`, async () => await runClassic(n, obj));
      bench(`big object -> (${n})`, async () => await runClassic(n, bigObj));
    }
  });

  await mitataRun({ format, print });
  await terminateAll();
  await terminateAllWorkers();
}
