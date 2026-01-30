import { bench, group, run as mitataRun, summary } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { format, print } from "./ulti/json-parse.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const add = task<number, number>({
  f: (value) => value + 1,
});

export const delayEcho = task<number, number>({
  f: async (ms) => {
    await delay(ms);
    return ms;
  },
});

const { call, send, shutdown } = createPool({
  threads: 1,
  worker: {
    timers: {
      spinMicroseconds: 10,
      parkMs: 5,
    },
  },
  dispatcher: {
    stallFreeLoops: 0,
    maxBackoffMs: 1,
  },
})({ add, delayEcho });

const runSyncBatch = (n: number) => {
  const tasks = Array.from({ length: n }, (_, i) => call.add(i));
  send();
  return Promise.all(tasks);
};

const runAsyncBatch = (n: number, ms: number) => {
  const tasks = Array.from({ length: n }, () => call.delayEcho(ms));
  send();
  return Promise.all(tasks);
};

if (isMain) {
  const burstSizes = [64, 256, 1024];
  const asyncSizes = [32, 128];

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

  await mitataRun({ format, print });
  await shutdown();
}
