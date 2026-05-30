import { bench, group, run as mitataRun, summary } from "mitata";
import { createPool, isMain, task } from "../../knitting.ts";
import { format, print } from "../util/json-parse.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const burstSizes = [64, 256, 1024];
const asyncSizes = [32, 128];
const poolOptions = {
  threads: 1,
  worker: {
    timers: {
      spinMicroseconds: 10,
      parkMs: 5,
    },
  },
  host: {
    stallFreeLoops: 0,
    maxBackoffMs: 1,
  },
} as const;

export const add = task<number, number>({
  f: (value) => value + 1,
});

export const delayEcho = task<number, number>({
  f: async (ms) => {
    await delay(ms);
    return ms;
  },
});

const registerLoopBenchmarks = ({
  runSyncBatch,
  runAsyncBatch,
}: {
  runSyncBatch: (n: number) => Promise<unknown>;
  runAsyncBatch: (n: number, ms: number) => Promise<unknown>;
}) => {
  group("knitting loop", () => {
    summary(() => {
      for (const n of burstSizes) {
        bench(`sync burst (${n})`, async () => {
          await runSyncBatch(n);
        });
      }

      for (const n of asyncSizes) {
        bench(`async 1ms (${n})`, async () => {
          await runAsyncBatch(n, 1);
        });
      }

      bench("idle gap 2x64", async () => {
        await runSyncBatch(64);
        await delay(2);
        await runSyncBatch(64);
      });
    });
  });
};

if (isMain) {
  const { call, shutdown } = createPool(poolOptions)({ add, delayEcho });
  const runSyncBatch = (n: number) => {
    const tasks = Array.from({ length: n }, (_, i) => call.add(i));
    return Promise.all(tasks);
  };
  const runAsyncBatch = (n: number, ms: number) => {
    const tasks = Array.from({ length: n }, () => call.delayEcho(ms));
    return Promise.all(tasks);
  };

  try {
    registerLoopBenchmarks({ runSyncBatch, runAsyncBatch });
    await mitataRun({ format, print });
  } finally {
    await shutdown();
  }
}
