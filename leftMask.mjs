// bitmask-bench.mjs
import { bench, group, run } from 'mitata';

// --- Precomputed mask table ---
const MASKS = Array.from({ length: 32 }, (_, i) => (1 << i) >>> 0);

// Simple rotating index to avoid constant folding
let idx = 0;
function nextIndex() {
  // 0–31 loop
  idx = (idx + 1) & 31;
  return idx;
}

group('bitmask: single mask retrieval', () => {
  bench('on-the-fly (shift)', () => {
    const i = nextIndex();
    const m = (1 << i) >>> 0;
    return m;
  });

  bench('lookup (precomputed array)', () => {
    const i = nextIndex();
    const m = MASKS[i];
    return m;
  });
});

// Optional: benchmark generating the *whole* 32-mask table each time
group('bitmask: generate full table vs reuse', () => {
  bench('generate 32 masks on-the-fly', () => {
    const arr = new Uint32Array(32);
    for (let i = 0; i < 32; i++) {
      arr[i] = (1 << i) >>> 0;
    }
    return arr;
  });

  bench('copy from precomputed table', () => {
    const arr = new Uint32Array(32);
    for (let i = 0; i < 32; i++) {
      arr[i] = MASKS[i];
    }
    return arr;
  });
});

await run();
