import { workerData } from "node:worker_threads";
import { readPayload, signalDebugger, writePayload } from "./utils.ts";
import { createWorkerQueue } from "./workerQueue.ts";
import { signalsForWorker, workerSignal } from "./signals.ts";
import { getFunctions } from "./taskApi.ts";

const mainLoop = async () => {
  const sharedSab = workerData.sab as SharedArrayBuffer;

  const signals = signalsForWorker({
    sharedSab,
  });

  const jobs = await getFunctions({
    list: workerData.list,
    isWorker: true,
    ids: workerData.ids,
  })
    .then(
      (objs) =>
        objs.map(
          (obj) => [obj.f],
        ),
    );

  if (jobs.length === 0) {
    console.log(workerData.list);
    console.log(workerData.ids);
    console.log(jobs);
    throw "no imports where found uwu";
  }
  const signal = workerSignal(signals);
  const reader = readPayload(signals);
  const writer = writePayload(signals);
  const { enqueue, nextJob, someHasFinished, write, allDone } =
    createWorkerQueue({
      //@ts-ignore Reason -> The type `job` was not well defined
      jobs,
      writer,
      reader,
      signal,
    });

  const { currentSignal, signalAllTasksDone } = signal;

  const getSignal = workerData?.debugSignal
    ? signalDebugger({
      thread: workerData.thread,
      currentSignal,
    })
    : currentSignal;

  while (true) {
    switch (getSignal()) {
      case 2:
      case 3:
      case 128:
      case 254:
      case 255: {
        continue;
      }
      case 0: {
        await nextJob();
        continue;
      }
      case 127: {
        await nextJob();

        if (someHasFinished()) {
          write();
          continue;
        }
        if (allDone()) {
          signalAllTasksDone();
          continue;
        }

        continue;
      }
      case 192:
        {
          enqueue();
        }

        continue;
    }
  }
};

mainLoop();
