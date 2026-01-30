import { bench, group, run as mitataRun } from "mitata";
import {
  LockBound,
  lock2,
  makeTask,
  TaskIndex,
  type Task,
} from "../src/memory/lock.ts";
import { decodePayload } from "../src/memory/payloadCodec.ts";
import { format, print } from "./ulti/json-parse.ts";

const makeLock = () => lock2({});
const makeLockWithBuffers = () => {
  const lockSector = new SharedArrayBuffer(
    LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
  );
  const headers = new SharedArrayBuffer(
    LockBound.padding +
      (LockBound.slots * TaskIndex.TotalBuff) * LockBound.slots,
  );
  const payload = new SharedArrayBuffer(
    64 * 1024 * 1024,
    { maxByteLength: 64 * 1024 * 1024 },
  );
  const lock = lock2({
    headers,
    LockBoundSector: lockSector,
    payload,
  });
  const headersBuffer = new Uint32Array(headers);
  const decode = decodePayload({ sab: payload, headersBuffer });
  return { lock, decode };
};

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

const makeObjectTask = (value: Record<string, unknown>) => {
  const task = makeTask();
  task.value = value;
  return task;
};

const lock = makeLock();
const single = makeNumberTask(123);
const batch16 = Array.from({ length: 16 }, (_, i) => makeNumberTask(i));
const batch32 = Array.from({ length: 32 }, (_, i) => makeNumberTask(i));
const smallString = "hello from lock";
const largeString = "helloWorld".repeat(100);
const singleString = makeStringTask(smallString);
const singleLargeString = makeStringTask(largeString);
const smallObject = { a: 1, b: "x",  };
const largeObject = {
  a: Array.from({ length: 256 }, (_, i) => i),
  b: { nested: true, label: "lock" },
  c: "x".repeat(256),
};
const smallArray = [1, 2, 3];
const singleObject = makeTask();
singleObject.value = smallObject;
const singleLargeObject = makeTask();
singleLargeObject.value = largeObject;
const singleArray = makeTask();
singleArray.value = smallArray;
const batch32Objects = Array.from(
  { length: 32 },
  (_, i) => makeObjectTask({ a: i, b: "x" }),
);
const batch16Strings = Array.from(
  { length: 16 },
  (_, i) => makeStringTask(`${smallString}-${i}`),
);
const resolveHostState = makeLockWithBuffers();
const resolveHostQueue = Array.from({ length: LockBound.slots }, (_, i) => {
  const task = makeTask();
  task[TaskIndex.ID] = i;
  return task;
});
const resolveHost = resolveHostState.lock.resolveHost({
  queue: resolveHostQueue,
  decode: resolveHostState.decode,
});
const resolveHostSingle = makeTask();
resolveHostSingle[TaskIndex.ID] = 0;
resolveHostSingle.value = 123;
const resolveHostBatch = Array.from({ length: 32 }, (_, i) => {
  const task = makeTask();
  task[TaskIndex.ID] = i;
  task.value = i;
  return task;
});

const ackAll = (registry: ReturnType<typeof makeLock>) => {
  // Match worker bits to host so all slots are free again.
  Atomics.store(registry.workerBits, 0, registry.hostBits[0]);
};

const encodeBatch = (
  registry: ReturnType<typeof makeLock>,
  tasks: Task[],
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

  // bench("roundtrip string (16)", () => {
  //   ackAll(lock);
  //   encodeBatch(lock, batch16Strings);
  //   lock.decode();
  //   lock.resolved.clear();
  // });

  bench("roundtrip object (1)", () => {
    ackAll(lock);
    lock.encode(singleObject);
    lock.decode();
    lock.resolved.clear();
  });

  bench("roundtrip object (32)", () => {
    ackAll(lock);
    encodeBatch(lock, batch32Objects);
    lock.decode();
    lock.resolved.clear();
  });

  bench("roundtrip large object (1)", () => {
    ackAll(lock);
    lock.encode(singleLargeObject);
    lock.decode();
    lock.resolved.clear();
  });

  bench("roundtrip array (1)", () => {
    ackAll(lock);
    lock.encode(singleArray);
    lock.decode();
    lock.resolved.clear();
  });

  bench("resolveHost (1)", () => {
    ackAll(resolveHostState.lock);
    resolveHostState.lock.encode(resolveHostSingle);
    resolveHost();
  });

  bench("resolveHost (32)", () => {
    ackAll(resolveHostState.lock);
    for (const task of resolveHostBatch) {
      resolveHostState.lock.encode(task);
    }
    resolveHost();
  });
});

await mitataRun({
  format,
  print,
});
