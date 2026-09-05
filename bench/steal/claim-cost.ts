/** Measure stealing claim throughput with no task-body work.
 * Configure with `CC_THREADS`, `CC_MS`, `CC_REPS`, `CC_G`, `CC_IDLE`,
 * `CC_BURST`, and `CC_CLAIM`.
 */
import { Worker } from "node:worker_threads";
import { createLockControlCarpet } from "../../src/memory/byte-carpet.ts";
import {
  HEADER_SLOT_STRIDE_U32,
  lock2,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  makeTask,
  type StealClaimDiscipline,
} from "../../src/memory/lock.ts";
import {
  resolveMaxStealRegionLanes,
  resolveStealRegionLanes,
} from "../../src/runtime/pool.ts";
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
const CLAIM: StealClaimDiscipline = process.env.CC_CLAIM === "cas-mask"
  ? "cas-mask"
  : "dekker";

// Control cells shared with every claimant.
const CTL_STATE = 0; // 0 = setup, 1 = running, 2 = stop
const CTL_READY = 1;
// Keep counters on separate cache lines to avoid false sharing.
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
        workerData: {
          shared,
          ctlSab,
          consumers,
          consumerId,
          regionLanes,
          stealClaim: CLAIM,
        },
      }),
  );

  // Wait for all claimant endpoints before starting the timed run.
  while (Atomics.load(ctl, CTL_READY) < consumers) await new Promise((r) => setTimeout(r, 5));

  const producer = lock2({ ...shared, consumers, regionLanes, stealClaim: CLAIM });
  const task = makeTask();
  let published = 0;
  let blocked = 0;
  let value = 0;

  Atomics.store(ctl, CTL_STATE, 1);
  const startedAt = performance.now();
  let now = startedAt;
  // Use claimant counters so burst mode is independent of lock internals.
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
        if (producer.encode(task)) published++;
        else blocked++;
      }
    }
    now = performance.now();
  } while (now - startedAt < RUN_MS);
  Atomics.store(ctl, CTL_STATE, 2);
  const ms = now - startedAt;

  // Allow an in-flight counter update to land before teardown.
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
    // Keep the default width comparable across claim disciplines.
    const maxLanes = resolveMaxStealRegionLanes(consumers, CLAIM);
    const regionLanes = FORCED_G > 0
      ? Math.min(FORCED_G, maxLanes)
      : resolveStealRegionLanes(consumers);
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
    // Divide aggregate claims by the number of claimants.
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
