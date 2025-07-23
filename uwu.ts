import { createThreadPool, fixedPoint, isMain } from "./main.ts";

/**
 * Worker‑side function: given `[start, end]`, return all primes in that range.
 */
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

const threads = 1;

export const { terminateAll, callFunction, fastCallFunction, send } =
  createThreadPool({
    threads,
    debug: {
      logMain: true,
    },
  })({ fn });

const LIMIT = 1_000_000; // Highest number to test
const CHUNK = 100_000;

if (isMain) {
  const tasks: Promise<number[]>[] = [];

  // Submit one task per chunk.
  for (let start = 2; start <= LIMIT; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, LIMIT);
    tasks.push(callFunction.fn([start, end]));
  }

  // Spin‑up the workers.
  send();

  let per = performance.now();
  // Gather and merge the results.
  const chunkPrimes = await Promise.all(tasks).finally(() => {
    console.log(performance.now() - per + " ms");
  });
  const primes = chunkPrimes.flat().sort((a, b) => a - b);

  console.log(`Found ${primes.length} primes ≤ ${LIMIT}`);
  console.log("Last 5 elements:", primes.slice(-6, -1));
  console.log("Largest prime:", primes.at(-1));

  // Quick demo of fastCallFunction with a small range.
  const smallPrimes = await fastCallFunction.fn([2, 30]);
  console.log("Primes between 2 and 30:", smallPrimes);

  terminateAll();
}
