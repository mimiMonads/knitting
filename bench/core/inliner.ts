import { bench, group, run as mitataRun, summary } from "mitata";
import { createPool, isMain, task } from "../../knitting.ts";
import { format, print } from "../ulti/json-parse.ts";

export const add = task<number, number>({
  f: (value) => value + 1,
});

export const echo = task<unknown, number>({
  f: (value) => value as number,
});

export const laneProbe = task<number, boolean>({
  f: () => isMain,
});

const BATCH = Math.max(1, Number(process.env.INLINER_BENCH_BATCH ?? "128"));
const GATED_THRESHOLD = Math.max(
  2,
  Number(process.env.INLINER_BENCH_GATED_THRESHOLD ?? "2048"),
);

let sink = 0;

const payload = new Array<number>(BATCH);
for (let i = 0; i < BATCH; i++) payload[i] = i;

const createWorkerOnly = () =>
  createPool({
    threads: 1,
    balancer: "robinRound",
  })({ add, echo, laneProbe });

const createInlinerPool = (dispatchThreshold: number) =>
  createPool({
    threads: 1,
    balancer: "robinRound",
    inliner: {
      position: "last",
      batchSize: 8,
      dispatchThreshold,
    },
  })({ add, echo, laneProbe });

const runSyncBurst = async (
  invoke: (value: number) => Promise<number>,
): Promise<void> => {
  const jobs = new Array<Promise<number>>(BATCH);
  for (let i = 0; i < BATCH; i++) {
    jobs[i] = invoke(payload[i]!);
  }
  const out = await Promise.all(jobs);
  let acc = sink;
  for (let i = 0; i < out.length; i++) acc ^= out[i]!;
  sink = acc;
};

const runPromiseArgBurst = async (
  invoke: (value: unknown) => Promise<number>,
): Promise<void> => {
  const jobs = new Array<Promise<number>>(BATCH);
  for (let i = 0; i < BATCH; i++) {
    jobs[i] = invoke(Promise.resolve(payload[i]!));
  }
  const out = await Promise.all(jobs);
  let acc = sink;
  for (let i = 0; i < out.length; i++) acc ^= out[i]!;
  sink = acc;
};

const sampleLaneUsage = async (
  invoke: (value: number) => Promise<boolean>,
): Promise<{ inline: number; worker: number }> => {
  const jobs = new Array<Promise<boolean>>(BATCH);
  for (let i = 0; i < BATCH; i++) {
    jobs[i] = invoke(i);
  }
  const out = await Promise.all(jobs);
  let inline = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === true) inline++;
  }
  return { inline, worker: out.length - inline };
};

if (isMain) {
  const workerOnly = createWorkerOnly();
  const inlinerGated = createInlinerPool(GATED_THRESHOLD);
  const inlinerActive = createInlinerPool(1);

  try {
    const [workerSample, gatedSample, activeSample] = await Promise.all([
      sampleLaneUsage(workerOnly.call.laneProbe),
      sampleLaneUsage(inlinerGated.call.laneProbe),
      sampleLaneUsage(inlinerActive.call.laneProbe),
    ]);

    console.log(
      `[inliner bench] laneProbe sample (batch=${BATCH}) ` +
        `workerOnly inline=${workerSample.inline} worker=${workerSample.worker}; ` +
        `gated inline=${gatedSample.inline} worker=${gatedSample.worker}; ` +
        `active inline=${activeSample.inline} worker=${activeSample.worker}`,
    );

    group(`inliner sync burst (${BATCH})`, () => {
      summary(() => {
        bench("worker only", async () => {
          await runSyncBurst(workerOnly.call.add);
        });
        bench(`inliner gated (threshold=${GATED_THRESHOLD})`, async () => {
          await runSyncBurst(inlinerGated.call.add);
        });
        bench("inliner active (threshold=1)", async () => {
          await runSyncBurst(inlinerActive.call.add);
        });
      });
    });

    group(`inliner promise-arg burst (${BATCH})`, () => {
      summary(() => {
        bench("worker only", async () => {
          await runPromiseArgBurst(workerOnly.call.echo);
        });
        bench(`inliner gated (threshold=${GATED_THRESHOLD})`, async () => {
          await runPromiseArgBurst(inlinerGated.call.echo);
        });
        bench("inliner active (threshold=1)", async () => {
          await runPromiseArgBurst(inlinerActive.call.echo);
        });
      });
    });

    await mitataRun({ format, print });

    if (sink === Number.MIN_SAFE_INTEGER) {
      console.log("unreachable", sink);
    }
  } finally {
    await Promise.all([
      workerOnly.shutdown(),
      inlinerGated.shutdown(),
      inlinerActive.shutdown(),
    ]);
  }
}
