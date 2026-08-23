/**
 * How expensive is one region-Dekker claim?
 *
 * `random-load.ts` measures whether stealing schedules well. This measures what
 * the claim protocol itself costs, with the task body removed: N real threads
 * spin `decode()` against one shared submit region while the host publishes as
 * fast as lanes free up. Nothing here computes anything, so throughput is the
 * coordination cost and nothing else.
 *
 * The number to watch is tasks-per-claim. Region width is not free to choose:
 * `resolveStealRegionLanes` picks the largest `g` with `slots / g >= N + 1`, so
 * `g` falls to 1 at 16 threads and every handshake retires a single lane. The
 * scan cost per claim, meanwhile, grows with N.
 *
 * CC_IDLE=1 publishes nothing instead, so every `decode()` returns on the
 * pending check alone. That isolates the discovery cost — one load of the
 * publication word plus one load of every peer ACK — which is what an idle
 * claimant pays on every pass of the worker loop.
 *
 * CC_BURST=k publishes only k tasks at a time and waits for them to drain
 * before publishing again. Saturating all 32 lanes leaves every region hot, so
 * where a claimant starts looking cannot matter; a small burst is the opposite
 * regime — a handful of pending lanes and N claimants racing for them, which is
 * what a per-consumer home region is supposed to keep apart.
 *
 * Env: CC_THREADS (comma-separated list)  CC_MS  CC_REPS  CC_G  CC_IDLE
 *      CC_BURST
 */
import { Worker } from "node:worker_threads";
import { createLockControlCarpet } from "../../src/memory/byte-carpet.ts";
import {
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  makeTask,
} from "../../src/memory/lock.ts";
import { resolveStealRegionLanes } from "../../src/runtime/pool.ts";
import "../../src/memory/payloadCodec.ts";

const THREAD_LIST = (process.env.CC_THREADS ?? "2,4,8,16")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 2);
const RUN_MS = Number(process.env.CC_MS ?? "600");
const REPS = Number(process.env.CC_REPS ?? "5");
const FORCED_G = Number(process.env.CC_G ?? "0");
const IDLE = process.env.CC_IDLE === "1";
const BURST = Number(process.env.CC_BURST ?? "0");

// Control cells shared with every claimant.
const CTL_STATE = 0; // 0 = setup, 1 = running, 2 = stop
const CTL_READY = 1;
// Counters start on their own cache line and get one line each: they are
// written while the run is in flight, and false sharing here would show up as
// claim cost.
const CTL_STRIDE = 16;
const CTL_COUNTERS = CTL_STRIDE; // then [claims, drained] per consumer

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
};

const withThousands = (value: number): string =>
  Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const runOnce = async (
  consumers: number,
  regionLanes: number,
): Promise<
  {
    claims: number;
    drained: number;
    polls: number;
    published: number;
    blocked: number;
    ms: number;
  }
> => {
  const carpet = createLockControlCarpet({
    signalBytes: 0,
    abortBytes: 0,
    lockSectorBytes: LOCK_SECTOR_BYTE_LENGTH,
    headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
    slotCount: LockBound.slots,
    headerLayout: "split",
  });
  const shared = {
    LockBoundSector: carpet.lock.lockSector,
    headers: carpet.lock.headers,
    payload: new SharedArrayBuffer(1 << 20),
    payloadSector: carpet.lock.payloadSector,
  };
  const ctlSab = new SharedArrayBuffer(
    (CTL_COUNTERS + consumers * CTL_STRIDE) * Int32Array.BYTES_PER_ELEMENT,
  );
  const ctl = new Int32Array(ctlSab);

  const workerUrl = new URL("./claim-cost-worker.ts", import.meta.url);
  const workers = Array.from(
    { length: consumers },
    (_, consumerId) =>
      new Worker(workerUrl, {
        workerData: { shared, ctlSab, consumers, consumerId, regionLanes },
      }),
  );

  // Spin until every claimant has built its endpoint; a worker still importing
  // modules would otherwise donate its share of the window to startup.
  while (Atomics.load(ctl, CTL_READY) < consumers) await new Promise((r) => setTimeout(r, 5));

  const producer = lock2({ ...shared, consumers, regionLanes });
  const task = makeTask();
  let published = 0;
  let blocked = 0;
  let value = 0;

  Atomics.store(ctl, CTL_STATE, 1);
  const startedAt = performance.now();
  let now = startedAt;
  // Claimants publish their drain counts as they go, so the host can wait on
  // those rather than on any lock internal. That keeps burst mode meaningful
  // across protocol variants.
  const drainedSoFar = () => {
    let total = 0;
    for (let c = 0; c < consumers; c++) {
      total += Atomics.load(ctl, CTL_COUNTERS + c * CTL_STRIDE + 1);
    }
    return total;
  };

  do {
    if (BURST > 0) {
      for (let i = 0; i < BURST; i++) {
        task.value = value++;
        if (producer.encode(task)) published++;
        else blocked++;
      }
      let spins = 0;
      while (drainedSoFar() < published && spins++ < 200_000) {
        /* let the burst clear */
      }
    } else if (!IDLE) {
      for (let i = 0; i < 64; i++) {
        task.value = value++;
        // A failed encode means all 32 lanes are still busy: the claimants are
        // behind. If this stays near zero the host is the bottleneck and no
        // consumer-side number in this run means anything.
        if (producer.encode(task)) published++;
        else blocked++;
      }
    }
    now = performance.now();
  } while (now - startedAt < RUN_MS);
  Atomics.store(ctl, CTL_STATE, 2);
  const ms = now - startedAt;

  // Claimants publish their counters as they go, but an oversubscribed thread
  // can be mid-batch here. Give them a moment to land the final store before
  // tearing the pool down.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.all(workers.map((worker) => worker.terminate()));

  let claims = 0;
  let drained = 0;
  let polls = 0;
  for (let c = 0; c < consumers; c++) {
    claims += Atomics.load(ctl, CTL_COUNTERS + c * CTL_STRIDE);
    drained += Atomics.load(ctl, CTL_COUNTERS + c * CTL_STRIDE + 1);
    polls += Atomics.load(ctl, CTL_COUNTERS + c * CTL_STRIDE + 2);
  }
  return { claims, drained, polls, published, blocked, ms };
};

const main = async () => {
  console.log(
    `claim cost — ${RUN_MS}ms x ${REPS} reps, ${LockBound.slots} slots\n`,
  );
  console.log(
    IDLE
      ? "threads    g   R     polls/s    ns/poll"
      : "threads    g   R   claims/s     tasks/s   tasks/claim   ns/claim",
  );
  for (const consumers of THREAD_LIST) {
    const maxLanes = resolveStealRegionLanes(consumers);
    const regionLanes = FORCED_G > 0 ? Math.min(FORCED_G, maxLanes) : maxLanes;
    const regions = LockBound.slots / regionLanes;

    const claimRates: number[] = [];
    const taskRates: number[] = [];
    const perClaim: number[] = [];
    const pollRates: number[] = [];
    const blockedShare: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const result = await runOnce(consumers, regionLanes);
      const seconds = result.ms / 1000;
      claimRates.push(result.claims / seconds);
      taskRates.push(result.drained / seconds);
      perClaim.push(result.claims === 0 ? 0 : result.drained / result.claims);
      pollRates.push(result.polls / seconds);
      blockedShare.push(
        result.blocked / Math.max(1, result.blocked + result.published),
      );
    }

    if (IDLE) {
      const pollsPerSecond = median(pollRates);
      console.log(
        `${consumers.toString().padStart(7)}` +
          `${regionLanes.toString().padStart(5)}` +
          `${regions.toString().padStart(4)}` +
          `${withThousands(pollsPerSecond).padStart(12)}` +
          `${((1e9 * consumers) / pollsPerSecond).toFixed(0).padStart(11)}`,
      );
      continue;
    }
    const claimsPerSecond = median(claimRates);
    // Wall time is shared by every claimant, so the per-claim cost is the
    // aggregate rate divided across the threads that produced it.
    const nsPerClaim = claimsPerSecond === 0
      ? 0
      : (1e9 * consumers) / claimsPerSecond;
    console.log(
      `${consumers.toString().padStart(7)}` +
        `${regionLanes.toString().padStart(5)}` +
        `${regions.toString().padStart(4)}` +
        `${withThousands(claimsPerSecond).padStart(11)}` +
        `${withThousands(median(taskRates)).padStart(12)}` +
        `${median(perClaim).toFixed(2).padStart(14)}` +
        `${nsPerClaim.toFixed(0).padStart(11)}` +
        `${(median(blockedShare) * 100).toFixed(1).padStart(13)}%`,
    );
  }
};

await main();
