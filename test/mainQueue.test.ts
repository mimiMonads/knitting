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

  assertEquals(true,true)
});
