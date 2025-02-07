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

  const signal = workerSignal(signals);
  const reader = readMessageToUint(signals);
  const writer = writeUintMessage(signals);

  const queue = multi({
    //@ts-ignore
    jobs,
    writer,
    reader,
    signal,
  });

  const on192 = queue.add(192);
  const on224 = queue.add(224);

  while (true) {
    switch (signal.curretSignal()) {
      case 0:
      case 1:
      case 2:
      case 128:
      case 254:
      case 255: {
        continue;
      }
      case 127: {
        await queue.nextJob();

        if (queue.someHasFinished()) {
          queue.write();
          continue;
        }
        if (queue.allDone()) {
          signal.finishedAllTasks();
          continue;
        }

        signal.messageWasRead();
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
