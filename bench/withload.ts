import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { format, print } from "./util/json-parse.ts";

export const fn = task({
  f: ([start, end]: [number, number]): number[] => {
    const primes: number[] = [];

    if (end < 2) return primes;
    if (start <= 2) primes.push(2);
    // make sure start is odd
    let n = Math.max(3, start + ((start % 2) === 0 ? 1 : 0));
    let sqrt = 0;
    let isPrime = true;
    for (; n <= end; n += 2) {
      sqrt = Math.floor(Math.sqrt(n));
      isPrime = true;
      for (let i = 3; i <= sqrt; i += 2) {
        if (n % i === 0) {
          isPrime = false;
          break;
        }
      }
      if (isPrime) primes.push(n);
    }
    return primes;
  },
});

if (isMain) {
  // Sized so a full A/B finishes in minutes rather than tens of them. The
  // shape of the workload is what matters here, not the absolute range.
  // Override with WITHLOAD_N / WITHLOAD_CHUNK / WITHLOAD_THREADS.
  const N = Number(process.env.WITHLOAD_N ?? 2_000_000); // search range: [1..N]
  const CHUNK_SIZE = Number(process.env.WITHLOAD_CHUNK ?? 250_000);
  const THREADS = (process.env.WITHLOAD_THREADS ?? "2,4")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 1);

  const partition = (end: number, chunk: number): [number, number][] => {
    const ranges: [number, number][] = [];
    for (let s = 1; s <= end; s += chunk) {
      const e = Math.min(s + chunk - 1, end);
      ranges.push([s, e]);
    }
    return ranges;
  };

  const runPrimeMain = async () => {
    const tasks = partition(N, CHUNK_SIZE).map((range) => fn.f(range));
    const results = await Promise.all(tasks);
    const totalCount = results.reduce((acc, arr) => acc + arr.length, 0);
    return totalCount;
  };

  const runPrimes = async (threads: number) => {
    const { call, shutdown } = createPool({
      threads,
      inliner: {
        position: "last",
        batchSize: 8
      },
    })({ fn });

    const tasks = partition(N, CHUNK_SIZE).map((range) => call.fn(range));
    const results = await Promise.all(tasks).finally(async () =>
      await shutdown()
    );

    // reduce to a count (avoid holding all primes)i
    const totalCount = results.reduce((acc, arr) => acc + arr.length, 0);

    return totalCount;
  };

  boxplot(async () => {
    group(
      `knitting: primes up to ${N.toLocaleString()} (chunk=${CHUNK_SIZE.toLocaleString()})`,
      () => {
        summary(() => {
          bench(`main`, async () => {
            await runPrimeMain();
          });
          for (const t of THREADS) {
            bench(
              `main + ${t - 1} extra thread${t > 1 ? "s" : ""} → full range`,
              async () => {
                await runPrimes(t - 1);
              },
            );
          }
        });
      },
    );
  });

  await mitataRun({ format, print });
}
