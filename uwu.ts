import { createThreadPool, fixedPoint, isMain } from "./main.ts";

/**
 * Worker‑side function: given `[start, end]`, return all primes in that range.
 */
export const fn = fixedPoint({
  f: async ([start, end]: [number, number]): Promise<number[]> => {
    const primes: number[] = [];

    outer: for (let n = Math.max(2, start); n <= end; n++) {
      // Trial division up to √n.
      for (let i = 2, sqrt = Math.floor(Math.sqrt(n)); i <= sqrt; i++) {
        if (n % i === 0) continue outer; // Not prime; skip to next n.
      }
      primes.push(n);
    }

    return primes;
  },
});

const threads = 4;

export const { terminateAll, callFunction, fastCallFunction, send } =
  createThreadPool({
    threads,
    //main: "first",
  })({ fn });

// ─────────────────────────────────────────────────────────────
// Example driver code (main thread only)
// ─────────────────────────────────────────────────────────────

const LIMIT = 1_000_000; // Highest number to test
const CHUNK = 10_000; // Range width per task

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
    console.log(performance.now() - per);
  });
  const primes = chunkPrimes.flat().sort((a, b) => a - b);

  console.log(`Found ${primes.length} primes ≤ ${LIMIT}`);
  console.log("Largest prime:", primes.at(-1));

  // Quick demo of fastCallFunction with a small range.
  const smallPrimes = await fastCallFunction.fn([2, 30]);
  console.log("Primes between 2 and 30:", smallPrimes);

  terminateAll();
}
