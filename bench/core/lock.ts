import { bench, group, run as mitataRun } from "mitata";
import RingQueue from "../../src/ipc/tools/RingQueue.ts";
import {
  HEADER_BYTE_LENGTH,
  LOCK_SECTOR_BYTE_LENGTH,
  LockBound,
  lock2,
  makeTask,
  TaskIndex,
  type Task,
} from "../../src/memory/lock.ts";
import { format, print } from "./../ulti/json-parse.ts";

const makeLock = () => lock2({});
const makeLockWithBuffers = () => {
  const lockSector = new SharedArrayBuffer(
    LOCK_SECTOR_BYTE_LENGTH,
  );
  const headers = new SharedArrayBuffer(HEADER_BYTE_LENGTH);
  const payload = new SharedArrayBuffer(
    64 * 1024 * 1024,
    { maxByteLength: 64 * 1024 * 1024 },
  );
  const lock = lock2({
    headers,
    LockBoundSector: lockSector,
    payload,
  });
  return { lock };
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
const batch32ObjectValues = Array.from(
  { length: 32 },
  (_, i) => ({ a: i, b: "x" }),
);
const batch32Objects = Array.from(
  { length: 32 },
  (_, i) => makeObjectTask(batch32ObjectValues[i]!),
);
const batch16Strings = Array.from(
  { length: 16 },
  (_, i) => makeStringTask(`${smallString}-${i}`),
);
const noop = () => {};
const resolveHostState = makeLockWithBuffers();
const resolveHostQueue = Array.from({ length: LockBound.slots }, (_, i) => {
  const task = makeTask();
  task[TaskIndex.ID] = i;
  return task;
});
const resolveHost = resolveHostState.lock.resolveHost({
  queue: resolveHostQueue,
});
const resolveHostOnResolvedState = makeLockWithBuffers();
const resolveHostOnResolvedQueue = Array.from(
  { length: LockBound.slots },
  (_, i) => {
    const task = makeTask();
    task[TaskIndex.ID] = i;
    return task;
  },
);
const resolveHostOnResolved = resolveHostOnResolvedState.lock.resolveHost({
  queue: resolveHostOnResolvedQueue,
  onResolved: noop,
});
const resolveHostRuntimeState = makeLockWithBuffers();
const resolveHostRuntimeQueue = Array.from({ length: LockBound.slots }, (_, i) => {
  const task = makeTask();
  task[TaskIndex.ID] = i;
  return task;
});
const resolveHostRuntime = resolveHostRuntimeState.lock.resolveHost({
  queue: resolveHostRuntimeQueue,
  shouldSettle: (task) => typeof task.reject === "function",
  onResolved: noop,
});
const resolveHostActivePlaceholder = (_?: unknown) => {};
const resolveHostActiveState = makeLockWithBuffers();
const resolveHostActiveQueue = Array.from(
  { length: LockBound.slots },
  (_, i) => {
    const task = makeTask();
    task[TaskIndex.ID] = i;
    return task;
  },
);
const resolveHostActive = resolveHostActiveState.lock.resolveHost({
  queue: resolveHostActiveQueue,
  activeRejectPlaceholder: resolveHostActivePlaceholder,
  onResolved: noop,
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

const refillNumberTasks = (tasks: Task[]) => {
  for (let i = 0; i < tasks.length; i++) {
    tasks[i]!.value = i;
  }
};

const fillQueue = (queue: RingQueue<Task>, tasks: Task[]) => {
  queue.clear();
  for (let i = 0; i < tasks.length; i++) {
    queue.push(tasks[i]!);
  }
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

  const encodeAllLock = makeLock();
  const encodeAllBatch = Array.from({ length: 32 }, (_, i) => makeNumberTask(i));
  bench("encodeAll pending (32)", () => {
    ackAll(encodeAllLock);
    encodeAllLock.resetPendingState();
    refillNumberTasks(encodeAllBatch);
    for (let i = 0; i < encodeAllBatch.length; i++) {
      encodeAllLock.enlist(encodeAllBatch[i]!);
    }
    encodeAllLock.encodeAll();
  });

  const flushPendingLock = makeLock();
  const flushPendingBatch = Array.from(
    { length: 32 },
    (_, i) => makeNumberTask(i),
  );
  bench("flushPending (32)", () => {
    ackAll(flushPendingLock);
    flushPendingLock.resetPendingState();
    refillNumberTasks(flushPendingBatch);
    for (let i = 0; i < flushPendingBatch.length; i++) {
      flushPendingLock.enlist(flushPendingBatch[i]!);
    }
    flushPendingLock.flushPending();
  });

  const encodeManyFromLock = makeLock();
  const encodeManyFromQueue = new RingQueue<Task>(32);
  const encodeManyFromBatch = Array.from(
    { length: 32 },
    (_, i) => makeNumberTask(i),
  );
  bench("encodeManyFrom external queue (32)", () => {
    ackAll(encodeManyFromLock);
    refillNumberTasks(encodeManyFromBatch);
    fillQueue(encodeManyFromQueue, encodeManyFromBatch);
    encodeManyFromLock.encodeManyFrom(encodeManyFromQueue);
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

  // bench("roundtrip string (1)", () => {
  //   ackAll(lock);
  //   lock.encode(singleString);
  //   lock.decode();
  //   lock.resolved.clear();
  // });

  // bench("roundtrip large string (1)", () => {
  //   ackAll(lock);
  //   lock.encode(singleLargeString);
  //   lock.decode();
  //   lock.resolved.clear();
  // });

  // // bench("roundtrip string (16)", () => {
  // //   ackAll(lock);
  // //   encodeBatch(lock, batch16Strings);
  // //   lock.decode();
  // //   lock.resolved.clear();
  // // });

  // bench("roundtrip object (1)", () => {
  //   ackAll(lock);
  //   singleObject.value = smallObject;
  //   lock.encode(singleObject);
  //   lock.decode();
  //   lock.resolved.clear();
  // });

  // bench("roundtrip object (32)", () => {
  //   ackAll(lock);
  //   for (let i = 0; i < batch32Objects.length; i++) {
  //     batch32Objects[i]!.value = batch32ObjectValues[i]!;
  //   }
  //   encodeBatch(lock, batch32Objects);
  //   lock.decode();
  //   lock.resolved.clear();
  // });

  // bench("roundtrip large object (1)", () => {
  //   ackAll(lock);
  //   singleLargeObject.value = largeObject;
  //   lock.encode(singleLargeObject);
  //   lock.decode();
  //   lock.resolved.clear();
  // });

  // bench("roundtrip array (1)", () => {
  //   ackAll(lock);
  //   singleArray.value = smallArray;
  //   lock.encode(singleArray);
  //   lock.decode();
  //   lock.resolved.clear();
  // });

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

  bench("resolveHost (1) + onResolved", () => {
    ackAll(resolveHostOnResolvedState.lock);
    resolveHostOnResolvedState.lock.encode(resolveHostSingle);
    resolveHostOnResolved();
  });

  bench("resolveHost (1) + shouldSettle + onResolved", () => {
    ackAll(resolveHostRuntimeState.lock);
    resolveHostRuntimeState.lock.encode(resolveHostSingle);
    resolveHostRuntime();
  });

  bench("resolveHost (1) + activeRejectPlaceholder + onResolved", () => {
    ackAll(resolveHostActiveState.lock);
    resolveHostActiveState.lock.encode(resolveHostSingle);
    resolveHostActive();
  });

  bench("resolveHost (32) + onResolved", () => {
    ackAll(resolveHostOnResolvedState.lock);
    for (const task of resolveHostBatch) {
      resolveHostOnResolvedState.lock.encode(task);
    }
    resolveHostOnResolved();
  });

  bench("resolveHost (32) + shouldSettle + onResolved", () => {
    ackAll(resolveHostRuntimeState.lock);
    for (const task of resolveHostBatch) {
      resolveHostRuntimeState.lock.encode(task);
    }
    resolveHostRuntime();
  });

  bench("resolveHost (32) + activeRejectPlaceholder + onResolved", () => {
    ackAll(resolveHostActiveState.lock);
    for (const task of resolveHostBatch) {
      resolveHostActiveState.lock.encode(task);
    }
    resolveHostActive();
  });
});

await mitataRun({
  format,
  print,
});
