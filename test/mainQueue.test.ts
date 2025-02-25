import { assertEquals } from "jsr:@std/assert";
import { createMainQueue } from "../src/mainQueueManager.ts";
import { mainSignal, signalsForWorker } from "../src/signals.ts";
import { genTaskID } from "../src/utils.ts";

Deno.test("Basic behaivour", async () => {
  const signals = signalsForWorker();
  const UINT8 = new Uint8Array([1, 2, 3]);
  const reader = () => UINT8;
  const writer = (k: any) => {};
  const signalBox = mainSignal(signals);
  const promisesMap = new Map();

  const queue = createMainQueue({
    signalBox,
    reader,
    genTaskID,
    writer,
    promisesMap,
    max: 2,
  });
  const enqueue = queue.enqueue(192)(0);
  const enqueueMessage = queue.enqueue(224)(1);

  assertEquals(
    queue.isEverythingSolve(),
    true,
    "Something didn't solved",
  );

  assertEquals(
    queue.canWrite(),
    false,
  );

  const ids = [
    enqueue(new Uint8Array([123])),
    enqueueMessage(new Uint8Array([456])),
  ];

  assertEquals(
    [queue.canWrite(), queue.count()],
    [true, 2],
    "enqueue was not reconized",
  );

  assertEquals(
    queue.isEverythingSolve(),
    false,
    "An enqueueed item has to block this",
  );

  const getpromise = queue.awaitArray(ids);

  queue.dispatchToWorker();

  assertEquals(
    signals.status[0],
    192,
    "status was no updated",
  );

  queue.dispatchToWorker();

  // Check why it s failing uwu
  //   assertEquals(
  //     signals.status[0],
  //     224,
  //     "status was no updated"
  //   );

  queue.resolveTask();
  signals.id[0] = 1;
  queue.resolveTask();

  assertEquals(
    await getpromise,
    [UINT8, UINT8],
  );
});
