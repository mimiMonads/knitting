import { B, bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { shutdownWorkers, toResolve } from "./postmessage/single.ts";
import { format, print } from "./ulti/json-parse.ts";
// ───────────────────────── fixed points ─────────────────────────
export const toNumber = task({ f: (a: number) => a });
export const toString = task({ f: (a: string) => a });
export const toBigInt = task({ f: (a: bigint) => a });
export const toBoolean = task({ f: (a: boolean) => a });
export const toVoid = task({ f: (_: void) => {} });
export const toObject = task({ f: (a: object) => a });

if (isMain) {
  const { call, shutdown, send } = createPool({})({
    toNumber,
    toString,
    toBigInt,
    toBoolean,
    toVoid,
    toObject,
  });

  const sizes = [1, 100];

  // helpers
  const runCF = async <T>(n: number, fn: () => Promise<T>) => {
    await Promise.all(Array.from({ length: n }, fn));
  };

  const runClassic = async <T>(n: number, val: T) => {
    await Promise.all(Array.from({ length: n }, () => toResolve(val)));
  };

  const user = (_, i: number) => ({
    id: i,
    name: `User ${i}`,
  });

  const times = 200;
  const string = "helloWorld";
  const bigString = "helloWorld".repeat(times);
  const num = 77777;
  const min = -(2n ** 63n - 1n);
  const max = 2n ** 64n - 1n;
  const smallArray = [1,2,3,4,5,6,7,8];

  const obj = user(null, 1);

  const bigArray = Array.from(
    { length: times },
    user,
  );

  const bigObj = {
    users: Array.from({ length: times }, user),
  };


  group("knitting", () => {
    for (const n of sizes) {

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

      bench(`string -> (${n})`, async () => {
        await runCF(n, async () => call.toString(string));
      });

      bench(
        `small array -> (${n})`,
        async () => await runCF(n, async () => call.toObject(smallArray)),
      );
      bench(
        `object -> (${n})`,
        async () => await runCF(n, async () => call.toObject(obj)),
      );
      bench(`large string -> (${n})`, async () => {
        await runCF(n, async () => call.toString(bigString));
      });
      bench(
        `big Array -> (${n})`,
        async () => {
          await runCF(n, async () => call.toObject(bigArray));
        },
      );
      bench(
        `big object -> (${n})`,
        async () => await runCF(n, async () => call.toObject(bigObj)),
      );
    }
  });

  group("worker", () => {
    for (const n of sizes) {

      bench(`number -> (${n})`, async () => {
        await runClassic(n, num);
      });
      bench(`min bigint -> (${n})`, async () => await runClassic(n, min));

      bench(`max bigint -> (${n})`, async () => await runClassic(n, max));
      bench(`boolean true -> (${n})`, async () => await runClassic(n, true));

      bench(`boolean false -> (${n})`, async () => await runClassic(n, false));

      bench(`void -> (${n})`, async () => await runClassic(n, undefined));

            bench(`string -> (${n})`, async () => {
        await runClassic(n, string);
      });

      bench(
        `small array -> (${n})`,
        async () => await runClassic(n, smallArray),
      );
  

      bench(`object -> (${n})`, async () => await runClassic(n, obj));
            bench(`large string -> (${n})`, async () => {
        await runClassic(n, bigString);
      });
       bench(`big Array -> (${n})`, async () => await runClassic(n, bigArray));

      bench(`big object -> (${n})`, async () => await runClassic(n, bigObj));
    }
  });

  await mitataRun({ format, print });
  await shutdown();
  await shutdownWorkers();
}
