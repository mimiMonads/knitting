import { workerData } from "node:worker_threads";
import { readMessageToUint, writeUintMessage } from "./helpers.ts";
import { multi } from "./workerQueue.ts";
import { signalsForWorker, workerSignal } from "./signal.ts";
import { getFunctions } from "./fixpoint.ts";

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
          (obj) => [obj.f, obj.statusSignal],
        ),
    );

  if (jobs.length === 0) {
    console.log(workerData.list);
    console.log(workerData.ids);
    console.log(jobs);
    throw "no imports where found uwu";
  }
  const signal = workerSignal(signals);
  const reader = readMessageToUint(signals);
  const writer = writeUintMessage(signals);
  const { add, nextJob, someHasFinished, write, allDone } = multi({
    //@ts-ignore Reason -> The type `job` was not well defined
    jobs,
    writer,
    reader,
    signal,
  });
  const { curretSignal, finishedAllTasks, messageWasRead } = signal;

  const on192 = add(192);
  const on224 = add(224);

  while (true) {
    switch (curretSignal()) {
      case 1:
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
          finishedAllTasks();
          continue;
        }

        messageWasRead();
        continue;
      }

      case 224:
        {
          on224();
        }
        continue;
      case 192:
        {
          on192();
        }

        continue;
    }
  }
};

mainLoop();
