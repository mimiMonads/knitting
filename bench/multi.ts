import { bench, group, run as runMitata, summary } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";

export const fn = fixedPoint({
  f: async (_: void) => {
    const start = 3, end = 100_000;
    const primes: number[] = [];
    if (end < 2) return primes;
    if (start <= 2) primes.push(2);
    // make sure start is odd
    let n = Math.max(3, start + ((start % 2) === 0 ? 1 : 0));
    for (; n <= end; n += 2) {
      const sqrt = Math.floor(Math.sqrt(n));
      let isPrime = true;
      for (let i = 3; i <= sqrt; i += 2) {
        if (n % i === 0) {
          isPrime = false;
          break;
        }
      }
      if (isPrime) primes.push(n);
    }
    return 2;
  },
});

const threads = 4;
const { terminateAll, callFunction, send, fastCallFunction } = createThreadPool(
  {
    threads,
    balancer: "firstAvailable",
  },
)({
  fn,
});

if (isMain) {
  bench("NOP", async () => {
    const arr = [
      callFunction.fn(),
      callFunction.fn(),
      callFunction.fn(),
      callFunction.fn(),
    ];

    send();

    await Promise.all(arr);
    await fastCallFunction.fn();
  });

  group("1", () => {
    summary(() => {
      bench(" Main -> 1", async () => {
        await fn.f();
      });

      bench(threads + " thread -> 1", async () => {
        await fastCallFunction.fn();
      });
    });
  });

  group("2", () => {
    summary(() => {
      bench(" Main -> 2", async () => {
        await Promise.all([
          fn.f(),
          fn.f(),
        ]);
      });

      bench(threads + " thread -> 2", async () => {
        const arr = [
          callFunction.fn(),
          callFunction.fn(),
        ];

        send();

        await Promise.all(arr);
      });
    });
  });

  group("3", () => {
    summary(() => {
      bench(" Main -> 3", async () => {
        await Promise.all([
          fn.f(),
          fn.f(),
          fn.f(),
        ]);
      });

      bench(threads + " thread -> 3", async () => {
        const arr = [
          callFunction.fn(),
          callFunction.fn(),
          callFunction.fn(),
        ];

        send();

        await Promise.all(arr);
      });
    });
  });

  group("4", () => {
    summary(() => {
      bench(" Main -> 4", async () => {
        await Promise.all([
          fn.f(),
          fn.f(),
          fn.f(),
          fn.f(),
        ]);
      });

      bench(threads + " thread -> 4", async () => {
        const arr = [
          callFunction.fn(),
          callFunction.fn(),
          callFunction.fn(),
          callFunction.fn(),
        ];

        send();

        await Promise.all(arr);
      });
    });
  });

  await runMitata();
  await terminateAll();
}
