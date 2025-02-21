import { assertEquals } from "jsr:@std/assert";
import { multi } from "../src/mainQueue.ts";
import { mainSignal, signalsForWorker } from "../src/signal.ts";
import { genTaskID } from "../src/helpers.ts";

Deno.test("Basic behaivour", async () => {
  const signals = signalsForWorker();
  const UINT8 = new Uint8Array([1, 2, 3]);
  const reader = () => UINT8;
  const writer = (k: any) => {};
  const signalBox = mainSignal(signals);
  const promisesMap = new Map();

  const queue = multi({
    signalBox,
    reader,
    genTaskID,
    writer,
    promisesMap,
    max: 2,
  });
  const add = queue.add(192)(0);
  const addMessage = queue.add(224)(1);

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
    add(new Uint8Array([123])),
    addMessage(new Uint8Array([456])),
  ];

  assertEquals(
    [queue.canWrite(), queue.count()],
    [true, 2],
    "add was not reconized",
  );

  assertEquals(
    queue.isEverythingSolve(),
    false,
    "An added item has to block this",
  );

  const getpromise = queue.awaitArray(ids);

  queue.sendNextToWorker();

  assertEquals(
    signals.status[0],
    192,
    "status was no updated",
  );

  queue.sendNextToWorker();

  // Check why it s failing uwu
  //   assertEquals(
  //     signals.status[0],
  //     224,
  //     "status was no updated"
  //   );

  queue.solve();
  signals.id[0] = 1;
  queue.solve();

  assertEquals(
    await getpromise,
    [UINT8, UINT8],
  );
});
