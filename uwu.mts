// --- Alignment methods -----------------------------------------

// Method A: shift-round
function alignShift(end: number): number {
  return ((end + 63) >> 6) << 6;
}

// Method B: bitmask-round
function alignMask(end: number): number {
  return (end + 63) & ~63;
}

// --- Main benchmarking logic -----------------------------------

function main() {
  const ITER = 500_000_000; // adjust if too slow in browser environment
  let sumA = 0;
  let sumB = 0;

  // Warm-up
  for (let i = 0; i < 1_000_000; i++) alignShift(i);
  for (let i = 0; i < 1_000_000; i++) alignMask(i);

  console.log("Starting benchmark…");

  // --- Test A --------------------------------------------------
  let tA = performance.now();
  for (let i = 0; i < ITER; i++) {
    sumA ^= alignShift(i);
  }
  tA = performance.now() - tA;

  // --- Test B --------------------------------------------------
  let tB = performance.now();
  for (let i = 0; i < ITER; i++) {
    sumB ^= alignMask(i);
  }
  tB = performance.now() - tB;

  // --- Results -------------------------------------------------
  console.log("sumA:", sumA, "time:", tA.toFixed(2), "ms");
  console.log("sumB:", sumB, "time:", tB.toFixed(2), "ms");

  if (tA === tB) {
    console.log("They are exactly equal (rare).");
  } else if (tA > tB) {
    console.log("Winner: alignMask (& ~63) is faster by", (tA - tB).toFixed(2), "ms");
  } else {
    console.log("Winner: alignShift (>>6<<6) is faster by", (tB - tA).toFixed(2), "ms (unexpected!)");
  }
}

main();
