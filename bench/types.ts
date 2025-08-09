import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { terminateAllWorkers, toResolve } from "./postmessage/single.ts";

// ───────────────────────── fixed points ─────────────────────────
export const toNumber = fixedPoint({ f: async (a: number) => a });
export const toString = fixedPoint({ f: async (a: string) => a });
export const toBigInt = fixedPoint({ f: async (a: bigint) => a });
export const toBoolean = fixedPoint({ f: async (a: boolean) => a });
export const toVoid = fixedPoint({ f: async (_: void) => {} });
export const toObject = fixedPoint({ f: async (a: object) => a });

// ───────────────────────── payloads ─────────────────────────────
const obj = {
  number: 123,
  string: "helloWorld",
  nullable: null,
  arr: [1, 2, 3, 4, 5],
};
const arrSmall = [1, 2, 3, 4, 5];

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

  const sizes = [1, 10];

  // helpers
  const runCF = async <T>(n: number, fn: () => Promise<T>) => {
    const promises = Array.from({ length: n }, fn);
    send(); // flush CF batch
    await Promise.all(promises);
  };
  const runFF = async <T>(n: number, fn: () => Promise<T>) => {
    if (n === 1) {
      return await fn();
    }
    await Promise.all(Array.from({ length: n }, fn));
  };
  const runClassic = async <T>(n: number, val: T) => {
    await Promise.all(Array.from({ length: n }, () => toResolve(val)));
  };

  // quick smoke: run once across many types (useful to warm things up)
  bench("smoke: all types (1 each)", async () => {
    const promises = [
      callFunction.toString("hello"),
      callFunction.toBigInt(-(2n ** 63n - 1n)),
      callFunction.toBigInt(2n ** 64n - 1n),
      callFunction.toBoolean(true),
      callFunction.toBoolean(false),
      callFunction.toVoid(),
      callFunction.toNumber(Infinity),
      callFunction.toNumber(-Infinity),
      callFunction.toNumber(NaN),
      callFunction.toNumber(Number.MAX_SAFE_INTEGER),
      callFunction.toNumber(Number.MIN_SAFE_INTEGER),
      callFunction.toNumber(Number.MAX_VALUE),
      callFunction.toNumber(Number.MIN_VALUE),
      callFunction.toNumber(0),
      callFunction.toNumber(2.2250738585072014e-308),
      callFunction.toObject(obj),
    ];
    send();
    await Promise.all(promises);
    await Promise.all([
      fastCallFunction.toString("hello"),
      fastCallFunction.toBigInt(-(2n ** 63n - 1n)),
      fastCallFunction.toBigInt(2n ** 64n - 1n),
      fastCallFunction.toBoolean(true),
      fastCallFunction.toBoolean(false),
      fastCallFunction.toVoid(),
      fastCallFunction.toNumber(Infinity),
      fastCallFunction.toNumber(-Infinity),
      fastCallFunction.toNumber(NaN),
      fastCallFunction.toNumber(Number.MAX_SAFE_INTEGER),
      fastCallFunction.toNumber(Number.MIN_SAFE_INTEGER),
      fastCallFunction.toNumber(Number.MAX_VALUE),
      fastCallFunction.toNumber(Number.MIN_VALUE),
      fastCallFunction.toNumber(0),
      fastCallFunction.toNumber(2.2250738585072014e-308),
      fastCallFunction.toObject(obj),
    ]);
  });

  // ───────────────────────── boxplots by type ─────────────────────────

  boxplot(async () => {
    // STRING

    summary(() => {
      for (const n of sizes) {
        const string = "helloWorld";
        group("string: " + n.toString(), () => {
          bench(`FF string `, async () => {
            await runFF(n, () => fastCallFunction.toString(string));
          });
          bench(`CF string`, async () => {
            await runCF(n, () => callFunction.toString(string));
          });
          bench(`classic string`, async () => {
            await runClassic(n, string);
          });
        });
      }
    });

    // NUMBER (finite)

    const num = 77777;
    summary(() => {
      for (const n of sizes) {
        group("number (finite):" + n, () => {
          bench(`CF number`, async () => {
            await runCF(n, () => callFunction.toNumber(num));
          });
          bench(`FF number`, async () => {
            await runFF(n, () => fastCallFunction.toNumber(num));
          });
          bench(`classic number`, async () => {
            await runClassic(n, num);
          });
        });
      }
    });

    // BIGINT

    summary(() => {
      const min = -(2n ** 63n - 1n);
      const max = 2n ** 64n - 1n;
      for (const n of sizes) {
        group("bigint: " + n, () => {
          bench(`FF bigint (min)`, async () => {
            await runFF(n, () => fastCallFunction.toBigInt(min));
          });
          bench(`FF bigint (max)`, async () => {
            await runFF(n, () => fastCallFunction.toBigInt(max));
          });
          bench(`CF bigint (min)`, async () => {
            await runCF(n, () => callFunction.toBigInt(min));
          });
          bench(`CF bigint (max)`, async () => {
            await runCF(n, () => callFunction.toBigInt(max));
          });
          bench(`classic bigint (min)`, async () => {
            await runClassic(n, min);
          });
          bench(`classic bigint (max)`, async () => {
            await runClassic(n, max);
          });
        });
      }
    });

    // BOOLEAN

    summary(() => {
      for (const n of sizes) {
        group("boolean:" + n.toString(), () => {
          bench(`FF boolean (true)`, async () => {
            await runFF(n, () => fastCallFunction.toBoolean(true));
          });
          bench(`CF boolean (true)`, async () => {
            await runCF(n, () => callFunction.toBoolean(true));
          });
          bench(`classic boolean (true)`, async () => {
            await runClassic(n, true);
          });
        });
        group("boolean: " + n.toString(), () => {
          bench(`FF boolean (false)`, async () => {
            await runFF(n, () => fastCallFunction.toBoolean(false));
          });
          bench(`CF boolean (false)`, async () => {
            await runCF(n, () => callFunction.toBoolean(false));
          });
          bench(`classic boolean (false)`, async () => {
            await runClassic(n, false);
          });
        });
      }
    });

    // VOID

    summary(() => {
      for (const n of sizes) {
        group("void/undefined: " + n.toString(), () => {
          bench(`FF void`, async () => {
            await runFF(n, () => fastCallFunction.toVoid());
          });
          bench(`CF void`, async () => {
            await runCF(n, () => callFunction.toVoid());
          });
          bench(`classic undefined`, async () => {
            await runClassic(n, undefined);
          });
        });
      }
    });

    // OBJECT & ARRAY

    summary(() => {
      for (const n of sizes) {
        group("object/array: " + n.toString(), () => {
          bench(`FF array (small)`, async () => {
            await runFF(n, () => fastCallFunction.toObject(arrSmall));
          });
          bench(`CF array (small)`, async () => {
            await runCF(n, () => callFunction.toObject(arrSmall));
          });
          bench(`classic array (small)`, async () => {
            await runClassic(n, arrSmall);
          });
        });
        group("object/array: " + n.toString(), () => {
          bench(`FF object`, async () => {
            await runFF(n, () => fastCallFunction.toObject(obj));
          });
          bench(`CF object`, async () => {
            await runCF(n, () => callFunction.toObject(obj));
          });

          bench(`classic object`, async () => {
            await runClassic(n, obj);
          });
        });
      }
    });
  });

  await mitataRun({ format: "markdown" });
  await terminateAll();
  await terminateAllWorkers();
}
