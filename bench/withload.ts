import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";

const  json = { debug: false, samples: false } 
const format = 
  process.argv.includes("--json")
  ? {
    json
  }
  : "markdown"


export const fn = fixedPoint({
  f: async ([start, end]: [number, number]): Promise<number[]> => {
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
    return primes;
  },
});

if (isMain) {
  const N = 10_000_000; // search range: [1..N]
  const CHUNK_SIZE = 100_000; // tune for load: 50 chunks for 10M
  const THREADS = [2, 3, 4, 5, 6]; // extra worker threads to compare

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
    const { callFunction, terminateAll, send } = createThreadPool({
      threads,
      main: "last",
    })({ fn });

    const tasks = partition(N, CHUNK_SIZE).map((range) =>
      callFunction.fn(range)
    );
    send(); // flush batch to workers
    const results = await Promise.all(tasks);

    // reduce to a count (avoid holding all primes)i
    const totalCount = results.reduce((acc, arr) => acc + arr.length, 0);

    await terminateAll();
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

  await mitataRun({ format });
}
