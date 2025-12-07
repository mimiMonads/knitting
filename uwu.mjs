// bench-worker.mjs
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { group, bench, run } from 'mitata';

const SAB_LENGTH = 1024; // number of Int32 elements

if (isMainThread) {
  // --- MAIN THREAD: create SAB and spawn worker ---
  const sab = new SharedArrayBuffer(SAB_LENGTH * Int32Array.BYTES_PER_ELEMENT);

  const worker = new Worker(new URL(import.meta.url), {
    workerData: { sab },
    type: 'module'
  });

  worker.on('message', (msg) => {
    console.log('[main] message from worker:', msg);
  });

  worker.on('error', (err) => {
    console.error('[main] worker error:', err);
  });

  worker.on('exit', (code) => {
    console.log('[main] worker exited with code', code);
  });
} else {
  // --- WORKER THREAD: receives SAB and runs benchmarks ---
  const sab = workerData.sab;
  const sabView = new Int32Array(sab);

  function makeObj() {
    return {
      0: 1,
      1: 2,
      2: 3,
      length: 3,
      hello: "world"
    };
  }

  function makeArr() {
    const a = new Uint32Array(3);
    a.hello = "world";
    return a;
  }

  class NumericObject {
    constructor(a, b, c) {
      this[0] = a;
      this[1] = b;
      this[2] = c;
      this.length = 3;
      this.a = "world";
    }
  }

  const obj = makeObj();
  const arr = makeArr();
  const objClass = new NumericObject(1, 2, 3);

  // Inner loop size – tune if needed
  const LOOPS_MUTATE_SET = 500_000;
  const MAX_OFFSET = sabView.length - 3; // we always write 3 ints

  // ---------- EXISTING BENCH: mutate+set into shared SAB ----------
  group('TypedArray.set with array-like sources (mutate + set into SHARED SAB, in worker)', () => {
    bench('plain array as source', () => {
      let sum = 0;

      for (let i = 0; i < LOOPS_MUTATE_SET; i++) {
        const r = (i * 2654435761) >>> 0;   // cheap pseudo-random
        const delta = (r & 0xff) | 1;       // small non-zero
        const offset = (r % MAX_OFFSET) | 0;

        // mutate array indices
        arr[0] += delta;
        arr[1] += delta;
        arr[2] += delta;

        // copy to *shared* SAB
        sabView.set(arr, offset);

        // touch SAB so nothing gets DCE’d
        sum += sabView[offset];
      }

      return sum;
    });

    bench('object literal (array-like) as source', () => {
      let sum = 0;

      for (let i = 0; i < LOOPS_MUTATE_SET; i++) {
        const r = (i * 2654435761) >>> 0;
        const delta = (r & 0xff) | 1;
        const offset = (r % MAX_OFFSET) | 0;

        // mutate object indices
        obj[0] += delta;
        obj[1] += delta;
        obj[2] += delta;

        // copy to *shared* SAB
        sabView.set(obj, offset);

        sum += sabView[offset];
      }

      return sum;
    });

    bench('class NumericObject (array-like) as source', () => {
      let sum = 0;

      for (let i = 0; i < LOOPS_MUTATE_SET; i++) {
        const r = (i * 2654435761) >>> 0;
        const delta = (r & 0xff) | 1;
        const offset = (r % MAX_OFFSET) | 0;

        // mutate class instance indices
        objClass[0] += delta;
        objClass[1] += delta;
        objClass[2] += delta;

        // copy to *shared* SAB
        sabView.set(objClass, offset);

        sum += sabView[offset];
      }

      return sum;
    });
  });

  // ---------- NEW BENCH: construction cost ----------
  const LOOPS_CONSTRUCT = 1_000_000; // separate loop-count for creation tests

  group('Construction cost (in worker)', () => {
    bench('create plain array + property', () => {
      let last;
      for (let i = 0; i < LOOPS_CONSTRUCT; i++) {
        last = makeArr();
      }
      // touch something so it’s not totally dead
      return last[0];
    });

    bench('create object literal', () => {
      let last;
      for (let i = 0; i < LOOPS_CONSTRUCT; i++) {
        last = makeObj();
      }
      return last[0];
    });

    bench('create class NumericObject', () => {
      let last;
      for (let i = 0; i < LOOPS_CONSTRUCT; i++) {
        last = new NumericObject(1, 2, 3);
      }
      return last[0];
    });
  });

  // Run mitata in the worker
  (async () => {
    await run();

    // sanity: show some SAB values back to main
    const preview = Array.from(sabView.slice(0, 6));
    parentPort?.postMessage({ type: 'sab-preview', preview });
  })();
}
