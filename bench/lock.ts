import { bench, group, run as mitataRun } from "mitata";
import { lock2, makeTask } from "../src/memory/lock.ts";
import { format, print } from "./ulti/json-parse.ts";

const makeLock = () => lock2({});

const makeNumberTask = (value: number) => {
  const task = makeTask();
  task.value = value;
  return task;
};

const makeStringTask = (value: string) => {
  const task = makeTask();
  task.value = value;
  return task;
};

const lock = makeLock();
const single = makeNumberTask(123);
const batch16 = Array.from({ length: 16 }, (_, i) => makeNumberTask(i));
const batch32 = Array.from({ length: 32 }, (_, i) => makeNumberTask(i));
const smallString = "hello from lock";
const largeString = "helloWorld".repeat(1000);
const singleString = makeStringTask(smallString);
const singleLargeString = makeStringTask(largeString);
const batch16Strings = Array.from(
  { length: 16 },
  (_, i) => makeStringTask(`${smallString}-${i}`),
);

const ackAll = (registry: ReturnType<typeof makeLock>) => {
  // Match worker bits to host so all slots are free again.
  Atomics.store(registry.workerBits, 0, registry.hostBits[0]);
};

const encodeBatch = (
  registry: ReturnType<typeof makeLock>,
  tasks: ReturnType<typeof makeNumberTask>[],
) => {
  for (const task of tasks) registry.encode(task);
};

group("lock", () => {
  bench("encode (1)", () => {
    ackAll(lock);
    lock.encode(single);
  });

  bench("encode (16)", () => {
    ackAll(lock);
    encodeBatch(lock, batch16);
  });

  bench("encode (32)", () => {
    ackAll(lock);
    encodeBatch(lock, batch32);
  });

  bench("roundtrip (1)", () => {
    ackAll(lock);
    lock.encode(single);
    lock.decode();
    lock.resolved.clear();
  });

  bench("roundtrip (16)", () => {
    ackAll(lock);
    encodeBatch(lock, batch16);
    lock.decode();
    lock.resolved.clear();
  });

  bench("roundtrip (32)", () => {
    ackAll(lock);
    encodeBatch(lock, batch32);
    lock.decode();
    lock.resolved.clear();
  });

  bench("roundtrip string (1)", () => {
    ackAll(lock);
    lock.encode(singleString);
    lock.decode();
    lock.resolved.clear();
  });

  bench("roundtrip large string (1)", () => {
    ackAll(lock);
    lock.encode(singleLargeString);
    lock.decode();
    lock.resolved.clear();
  });

  bench("roundtrip string (16)", () => {
    ackAll(lock);
    encodeBatch(lock, batch16Strings);
    lock.decode();
    lock.resolved.clear();
  });
});

await mitataRun({
  format,
  print,
});
