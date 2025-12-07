// bench-lock2.mts
import { bench, group, run } from 'mitata';

import {
  lock2,
  Lock,
  TaskIndex,
  makeTask,
  recover,
  type Task,
} from './lock.ts';

// --- Shared setup: one lock instance, one SAB layout ---

// Same layout you use inside lock2
const lockSector = new SharedArrayBuffer(
  Lock.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
);

const headers = new SharedArrayBuffer(
  (Lock.padding + Lock.slots * TaskIndex.Length) * Lock.slots *400 ,
);

// let lock2 create its own toBeSent / resolved queues
const q = lock2({ headers, lockSector });

// Helper: drain q.resolved, call recover() on each
function drainResolved() {
  // adjust this if your LinkList API differs
  let node = (q.resolved as any).shift?.() as Task | undefined;

  while (node) {
    recover(node);
    node = (q.resolved as any).shift?.() as Task | undefined;
  }
}

// Helper: enqueue K tasks into toBeSent
function enqueueK(k: number, payload: unknown) {
  for (let i = 0; i < k; i++) {
    const t = makeTask();
    t.value = payload;
    q.enlist(t);
  }
}

// --- Benchmarks ---

group('lock2 single-thread', () => {
  // 1) Single-task roundtrip using encode + decode directly
  bench('single encode+decode (number)', () => {
    const t = makeTask();
    t.value = 123.456;

    if (!q.encode(t)) {
      throw new Error('encode failed: no free slot');
    }

    q.decode();
    drainResolved();
  });

  // 2) encodeAll for up to `slots` tasks
  bench(`encodeAll up to Lock.slots (${Lock.slots} tasks)`, () => {
    // Make sure queues are empty from previous iteration
    drainResolved();

    // Enqueue exactly Lock.slots tasks
    enqueueK(Lock.slots, 42);

    const ok = (q as any).encodeAll?.();
    if (!ok) {
      throw new Error('encodeAll: did not accommodate all tasks (unexpected with empty slots)');
    }

    // Bring them back out
    q.decode();
    drainResolved();
  });

  // 3) encodeAll with fewer tasks (e.g. half the slots)
  bench(`encodeAll half slots (${Lock.slots / 2} tasks)`, () => {
    drainResolved();

    const count = Lock.slots / 2;
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
