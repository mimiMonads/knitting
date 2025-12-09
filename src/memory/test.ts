// bench-lock2.mts
import { bench, group, run } from 'mitata';

import {
  lock2,
  Lock,
  TaskIndex,
  makeTask,
  type Task,
} from './lock.ts';

// --- Shared setup: one lock instance, one SAB layout ---

// Same layout you use inside lock2
const lockSector = new SharedArrayBuffer(
  Lock.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
);

const headers = new SharedArrayBuffer(
  (Lock.padding + Lock.slots * TaskIndex.Length) * Lock.slots * 400,
);

// let lock2 create its own toBeSent / resolved queues
const q = lock2({ headers, lockSector });

// ---- Task pool so benchmarks REUSE tasks instead of allocating ----

// Pool size: enough for the largest batch (Lock.slots)
const TASK_POOL_SIZE = Lock.slots;

// Create a fixed pool of Tasks once
const taskPool: Task[] = Array.from({ length: TASK_POOL_SIZE }, () => makeTask());

// Single task reused by the "single encode+decode" benchmark
const singleTask: Task = taskPool[0];

// Helper: drain q.resolved, call recover() on each
function drainResolved() {
  // adjust this if your LinkList API differs
  let node = (q.resolved as any).shift?.() as Task | undefined;

  while (node) {
    // If you later add a recover() on Task, invoke it here.
    node = (q.resolved as any).shift?.() as Task | undefined;
  }
}

// Helper: enqueue K tasks into toBeSent, reusing the pool
function enqueueK(k: number, payload: unknown) {
  for (let i = 0; i < k; i++) {
    const t = taskPool[i];      // reuse preallocated task
    t.value = payload;          // just change the payload
    q.enlist(t);
  }
}

// --- Benchmarks ---

group('lock2 single-thread', () => {
  // 1) Single-task roundtrip using encode + decode directly
  bench('single encode+decode (number)', () => {
    // reuse the same task every iteration
    singleTask.value = 123.456;

    if (!q.encode(singleTask)) {
      throw new Error('encode failed: no free slot');
    }

    q.decode();
    drainResolved();
  });

  // 2) encodeAll for up to `slots` tasks
  bench(`encodeAll up to Lock.slots (${Lock.slots} tasks)`, () => {
    // enqueue exactly Lock.slots tasks, all reused from pool
    enqueueK(Lock.slots, 42);

    const ok = (q as any).encodeAll?.();
    if (!ok) {
      throw new Error('encodeAll: did not accommodate all tasks (unexpected with empty slots)');
    }

    // Bring them back out
    q.decode();
    drainResolved();
  });

  const count = Lock.slots / 2;

  // 3) encodeAll with fewer tasks (e.g. half the slots)
  bench(`encodeAll half slots (${Lock.slots / 2} tasks)`, () => {
    // reuse first `count` tasks from the same pool
    enqueueK(count, 999);

    const ok = (q as any).encodeAll?.();
    if (!ok) {
      throw new Error('encodeAll: failed with half slots (unexpected)');
    }

    q.decode();
    drainResolved();
  });
});

await run();
