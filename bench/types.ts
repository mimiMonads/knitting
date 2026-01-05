import { B, bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { shutdownWorkers, toResolve } from "./postmessage/single.ts";
import { format, print } from "./ulti/json-parse.ts";
// ───────────────────────── fixed points ─────────────────────────
export const toNumber = task({ f: async (a: number) => a });
export const toString = task({ f: async (a: string) => a });
export const toBigInt = task({ f: async (a: bigint) => a });
export const toBoolean = task({ f: async (a: boolean) => a });
export const toVoid = task({ f: async (_: void) => {} });
export const toObject = task({ f: async (a: object) => a });

if (isMain) {
  const { call, fastCall, shutdown, send } = createPool({})({
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

  const user = (_, i: number) => ({
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
  });

  const times = 100;
  const string = "helloWorld";
  const bigString = "helloWorld".repeat(times);
  const num = 77777;
  const min = -(2n ** 63n - 1n);
  const max = 2n ** 64n - 1n;
  const smallArray = [...Object.values(user(null, 1))];

  const obj = user(null, 1);

  const bigArray = Array.from(
    { length: times },
    user,
  );

  const bigObj = {
    users: Array.from({ length: times }, user),
  };

  group("knitting fast", () => {
    bench(`string -> (1)`, async () => {
      await fastCall.toString(string);
    });
    bench(`large string -> (1)`, async () => {
      await fastCall.toString(bigString);
    });
    bench(`number -> (1)`, async () => {
      await fastCall.toNumber(num);
    });
    bench(
      `min bigint -> (1)`,
      async () => await fastCall.toBigInt(min),
    );
    bench(
      `max bigint -> (1)`,
      async () => await fastCall.toBigInt(max),
    );
    bench(
      `boolean true -> (1)`,
      async () => await fastCall.toBoolean(true),
    );
    bench(
      `boolean false -> (1)`,
      async () => await fastCall.toBoolean(false),
    );
    bench(`void -> (1)`, async () => await fastCall.toVoid());
    bench(
      `small array -> (1)`,
      async () => await fastCall.toObject(smallArray),
    );
    bench(
      `big Array -> (1)`,
      async () => await fastCall.toObject(bigArray),
    );
    bench(`object -> (1)`, async () => await fastCall.toObject(obj));
    bench(
      `big object -> (1)`,
      async () => await fastCall.toObject(bigObj),
    );

    const firstRemoved = sizes.slice(1);

    for (const n of firstRemoved) {
      bench(`string -> (${n})`, async () => {
        await runFF(n, async () => fastCall.toString(string));
      });
      bench(`large string -> (${n})`, async () => {
        await runFF(n, async () => fastCall.toString(bigString));
      });
      bench(`number -> (${n})`, async () => {
        await runFF(n, async () => fastCall.toNumber(num));
      });
      bench(
        `min bigint -> (${n})`,
        async () => await runFF(n, async () => fastCall.toBigInt(min)),
      );

      bench(
        `max bigint -> (${n})`,
        async () => await runFF(n, async () => fastCall.toBigInt(max)),
      );
      bench(
        `boolean true -> (${n})`,
        async () => await runFF(n, async () => fastCall.toBoolean(true)),
      );

      bench(
        `boolean false -> (${n})`,
        async () => await runFF(n, async () => fastCall.toBoolean(false)),
      );

      bench(
        `void -> (${n})`,
        async () => await runFF(n, async () => fastCall.toVoid()),
      );
      bench(
        `small array -> (${n})`,
        async () => await runFF(n, async () => fastCall.toObject(smallArray)),
      );

      bench(
        `big Array -> (${n})`,
        async () => await runFF(n, async () => fastCall.toObject(bigArray)),
      );
      bench(
        `object -> (${n})`,
        async () => await runFF(n, async () => fastCall.toObject(obj)),
      );
      bench(
        `big object -> (${n})`,
        async () => await runFF(n, async () => fastCall.toObject(bigObj)),
      );
    }
  });

  group("knitting", () => {
    for (const n of sizes) {
      bench(`string -> (${n})`, async () => {
        await runCF(n, async () => call.toString(string));
      });
      bench(`large string -> (${n})`, async () => {
        await runCF(n, async () => call.toString(bigString));
      });
      bench(`number -> (${n})`, async () => {
        await runCF(n, async () => call.toNumber(num));
      });
      bench(
        `min bigint -> (${n})`,
        async () => await runCF(n, async () => call.toBigInt(min)),
      );

      bench(
        `max bigint -> (${n})`,
        async () => await runCF(n, async () => call.toBigInt(max)),
      );
      bench(
        `boolean true -> (${n})`,
        async () => await runCF(n, async () => call.toBoolean(true)),
      );

      bench(
        `boolean false -> (${n})`,
        async () => await runCF(n, async () => call.toBoolean(false)),
      );

      bench(
        `void -> (${n})`,
        async () => await runCF(n, async () => call.toVoid()),
      );
      bench(
        `small array -> (${n})`,
        async () => await runCF(n, async () => call.toObject(smallArray)),
      );

      bench(
        `big Array -> (${n})`,
        async () => {
          await runCF(n, async () => call.toObject(bigArray));
        },
      );
      bench(
        `object -> (${n})`,
        async () => await runCF(n, async () => call.toObject(obj)),
      );
      bench(
        `big object -> (${n})`,
        async () => await runCF(n, async () => call.toObject(bigObj)),
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
  await shutdown();
  await shutdownWorkers();
}
