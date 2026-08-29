/**
 * Measures the cost of widening the lock signal word from Int32 to BigInt64.
 *
 * Both views occupy a 64-byte cache line, matching lock.ts. The BigInt64 cases
 * use the operations a 64-lane lock would need: XOR a lane bit before publish,
 * and load/select a lane from the upper 32 bits while draining. It also tests
 * the best safe `clz32` route: bit-cast an atomically-loaded bigint through a
 * thread-local Int32 view. This is a single-threaded latency benchmark; it
 * deliberately does not claim to measure cross-core cache-line contention.
 */

const CACHE_LINE_BYTES = 64;
const ITERATIONS = 10_000_000;
const SAMPLE_COUNT = 7;
const WARMUP_COUNT = 2;

const runtime = globalThis as typeof globalThis & {
  Deno?: { version: { deno: string } };
  Bun?: { version: string };
};
const isDeno = runtime.Deno !== undefined;
const isBun = runtime.Bun !== undefined;
// Deno and Bun expose Node-compatible `process`, so test their native globals
// first before deciding that this is Node.
const isNode = !isDeno && !isBun &&
  typeof process !== "undefined" &&
  typeof process.versions?.node === "string";

const runtimeLabel = isNode
  ? `node ${process.version}`
  : isDeno
  ? `deno ${runtime.Deno!.version.deno}`
  : isBun
  ? `bun ${runtime.Bun!.version}`
  : "unknown runtime";

const nowNs = isNode && typeof process.hrtime?.bigint === "function"
  ? () => Number(process.hrtime.bigint())
  : () => performance.now() * 1_000_000;

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >>> 1;
  return sorted.length & 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const format = (value: number, digits = 1): string =>
  value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });

type Sample = () => number;
type Row = {
  name: string;
  nsPerOperation: number;
  relativeToInt32: number;
};
type BenchmarkPair = {
  int32Name: string;
  int32Sample: Sample;
  candidatePrefix: string;
  candidateName: string;
  candidateSample: Sample;
};

// Keep every result observable without performing a BigInt operation in the
// timed loops beyond those required by the 64-bit lock representation.
const sink = { number: 0, bigint: 0n };

const isLittleEndian = (() => {
  const word = new Uint32Array([0x01020304]);
  return new Uint8Array(word.buffer)[0] === 0x04;
})();
const HIGH_WORD_INDEX = isLittleEndian ? 1 : 0;
const NORMAL_XOR_MASK_COUNT = 64;
const normalNumberMasks = new Int32Array(NORMAL_XOR_MASK_COUNT);
const normalBigIntMasks: bigint[] = new Array(NORMAL_XOR_MASK_COUNT);
for (let index = 0; index < NORMAL_XOR_MASK_COUNT; index++) {
  const value = Math.imul(index + 1, 0x9e3779b1) | 0;
  normalNumberMasks[index] = value;
  normalBigIntMasks[index] = BigInt(value);
}

const makeInt32Sample = (
  run: (cells: Int32Array, iterations: number) => number,
): Sample => {
  const cells = new Int32Array(new SharedArrayBuffer(CACHE_LINE_BYTES));
  return () => {
    const started = nowNs();
    const result = run(cells, ITERATIONS);
    const elapsed = nowNs() - started;
    sink.number ^= result;
    return elapsed;
  };
};

const makeBigInt64Sample = (
  run: (cells: BigInt64Array, iterations: number) => bigint,
): Sample => {
  const cells = new BigInt64Array(new SharedArrayBuffer(CACHE_LINE_BYTES));
  return () => {
    const started = nowNs();
    const result = run(cells, ITERATIONS);
    const elapsed = nowNs() - started;
    sink.bigint ^= result;
    return elapsed;
  };
};

const makeTwoInt32Sample = (
  run: (cells: Int32Array, iterations: number) => number,
): Sample => {
  // Logical word 0 is lanes 0..31 and word 1 is lanes 32..63. This is the
  // portable non-BigInt alternative: two independent 32-bit atomic words in
  // the same 64-byte signal line.
  const cells = new Int32Array(new SharedArrayBuffer(CACHE_LINE_BYTES));
  return () => {
    const started = nowNs();
    const result = run(cells, ITERATIONS);
    const elapsed = nowNs() - started;
    sink.number ^= result;
    return elapsed;
  };
};

// These ordinary reads are intentionally non-atomic and exist only to measure
// JS arithmetic. The dynamic 64-entry mask makes each XOR input unknown to the
// optimizer; do not use this as synchronization code.
let numberReadSeed = 0;
const int32NormalRead = makeInt32Sample((_cells, iterations) => {
  let cursor = numberReadSeed = (numberReadSeed + 29) & 63;
  let state = 0;
  for (let index = 0; index < iterations; index++) {
    cursor = (Math.imul(cursor, 13) + 17) & 63;
    state = normalNumberMasks[cursor]!;
  }
  return state;
});

let bigintReadSeed = 0;
const bigint64NormalRead = makeBigInt64Sample((_cells, iterations) => {
  let cursor = bigintReadSeed = (bigintReadSeed + 29) & 63;
  let state = 0n;
  for (let index = 0; index < iterations; index++) {
    cursor = (Math.imul(cursor, 13) + 17) & 63;
    state = normalBigIntMasks[cursor]!;
  }
  return state;
});

let numberXorSeed = 0;
const int32NormalXor = makeInt32Sample((_cells, iterations) => {
  let cursor = numberXorSeed = (numberXorSeed + 29) & 63;
  let state = 0;
  for (let index = 0; index < iterations; index++) {
    cursor = (Math.imul(cursor, 13) + 17) & 63;
    state = (state ^ normalNumberMasks[cursor]!) | 0;
  }
  return state;
});

let bigintXorSeed = 0;
const bigint64NormalXor = makeBigInt64Sample((_cells, iterations) => {
  let cursor = bigintXorSeed = (bigintXorSeed + 29) & 63;
  let state = 0n;
  for (let index = 0; index < iterations; index++) {
    cursor = (Math.imul(cursor, 13) + 17) & 63;
    state ^= normalBigIntMasks[cursor]!;
  }
  return state;
});

const int32Load = makeInt32Sample((cells, iterations) => {
  Atomics.store(cells, 0, 1);
  let result = 0;
  for (let index = 0; index < iterations; index++) {
    result = Atomics.load(cells, 0);
  }
  return result;
});

const bigint64Load = makeBigInt64Sample((cells, iterations) => {
  Atomics.store(cells, 0, 1n);
  let result = 0n;
  for (let index = 0; index < iterations; index++) {
    result = Atomics.load(cells, 0);
  }
  return result;
});

// Fixed-value stores isolate the atomic call and its Number/BigInt API
// boundary. The toggle variants below add the writer-owned shadow update used
// by lock.ts, so their difference is the practical cost of `state ^= bit`.
const int32Store = makeInt32Sample((cells, iterations) => {
  for (let index = 0; index < iterations; index++) {
    Atomics.store(cells, 0, 1);
  }
  return Atomics.load(cells, 0);
});

const bigint64Store = makeBigInt64Sample((cells, iterations) => {
  for (let index = 0; index < iterations; index++) {
    Atomics.store(cells, 0, 1n);
  }
  return Atomics.load(cells, 0);
});

// This mirrors storeHost/storeWorker: update the writer-owned local shadow and
// publish it with a sequentially-consistent store. A lane in the high half is
// used for the 64-bit version so the widened capacity is actually exercised.
const int32ToggleAndStore = makeInt32Sample((cells, iterations) => {
  let state = 0;
  const bit = 1 << 31;
  for (let index = 0; index < iterations; index++) {
    state = (state ^ bit) | 0;
    Atomics.store(cells, 0, state);
  }
  return Atomics.load(cells, 0);
});

// Atomics.xor removes the JavaScript-local XOR, but replaces a store with a
// read-modify-write operation. It preserves the single-writer signal protocol;
// contention still needs a separate benchmark because an RMW can have a higher
// cache-coherence cost than a plain store.
const int32AtomicXor = makeInt32Sample((cells, iterations) => {
  Atomics.store(cells, 0, 0);
  const bit = 1 << 31;
  for (let index = 0; index < iterations; index++) {
    Atomics.xor(cells, 0, bit);
  }
  return Atomics.load(cells, 0);
});

const bigint64AtomicXor = makeBigInt64Sample((cells, iterations) => {
  Atomics.store(cells, 0, 0n);
  const bit = -(1n << 63n);
  for (let index = 0; index < iterations; index++) {
    Atomics.xor(cells, 0, bit);
  }
  return Atomics.load(cells, 0);
});

// A 64-lane implementation can retain its local shadow as two Numbers. The
// only BigInt then is the precomputed mask passed to Atomics.xor; no BigInt
// arithmetic is performed in JavaScript. This is the practical alternative to
// `LastLocalBigInt ^= bit; Atomics.store(...)` for a single-writer signal word.
const int32NumberShadowAndAtomicXor = makeInt32Sample((cells, iterations) => {
  Atomics.store(cells, 0, 0);
  let shadow = 0;
  const bit = 1 << 31;
  for (let index = 0; index < iterations; index++) {
    shadow = (shadow ^ bit) | 0;
    Atomics.xor(cells, 0, bit);
  }
  return shadow ^ Atomics.load(cells, 0);
});

const bigint64NumberShadowAndAtomicXor = makeBigInt64Sample(
  (cells, iterations) => {
    Atomics.store(cells, 0, 0n);
    let shadowHigh = 0;
    const numberBit = 1 << 31;
    const bigintBit = -(1n << 63n);
    for (let index = 0; index < iterations; index++) {
      shadowHigh = (shadowHigh ^ numberBit) | 0;
      Atomics.xor(cells, 0, bigintBit);
    }
    return BigInt(shadowHigh) ^ Atomics.load(cells, 0);
  },
);

const bigint64ToggleAndStore = makeBigInt64Sample((cells, iterations) => {
  let state = 0n;
  const bit = -(1n << 63n);
  for (let index = 0; index < iterations; index++) {
    state ^= bit;
    Atomics.store(cells, 0, state);
  }
  return Atomics.load(cells, 0);
});

// The current receiver gets its highest pending lane with clz32. The direct
// BigInt version below is the simple baseline. The bit-cast version shows the
// cheapest safe way to keep clz32: move the already-loaded bigint into a local
// (non-shared) 8-byte buffer, then read its high Int32 word.
const int32LoadAndSelectHighLane = makeInt32Sample((cells, iterations) => {
  Atomics.store(cells, 0, 1 << 31);
  let selected = 0;
  for (let index = 0; index < iterations; index++) {
    selected = 31 - Math.clz32(Atomics.load(cells, 0));
  }
  return selected;
});

const bigint64LoadAndSelectHighLane = makeBigInt64Sample(
  (cells, iterations) => {
    Atomics.store(cells, 0, -(1n << 63n));
    let selected = 0;
    for (let index = 0; index < iterations; index++) {
      const high = Number(Atomics.load(cells, 0) >> 32n);
      selected = 63 - Math.clz32(high);
    }
    return BigInt(selected);
  },
);

const bigint64LoadAndBitcastSelectHighLane = makeBigInt64Sample(
  (cells, iterations) => {
    Atomics.store(cells, 0, -(1n << 63n));
    const local64 = new BigInt64Array(new ArrayBuffer(8));
    const local32 = new Int32Array(local64.buffer);
    let selected = 0;
    for (let index = 0; index < iterations; index++) {
      local64[0] = Atomics.load(cells, 0);
      selected = 63 - Math.clz32(local32[HIGH_WORD_INDEX]!);
    }
    return BigInt(selected);
  },
);

const twoInt32LoadAndSelectHighLane = makeTwoInt32Sample(
  (cells, iterations) => {
    Atomics.store(cells, 1, 1 << 31);
    let selected = 0;
    for (let index = 0; index < iterations; index++) {
      selected = 63 - Math.clz32(Atomics.load(cells, 1));
    }
    return selected;
  },
);

const twoInt32ToggleAndStoreHighLane = makeTwoInt32Sample(
  (cells, iterations) => {
    let state = 0;
    const bit = 1 << 31;
    for (let index = 0; index < iterations; index++) {
      state = (state ^ bit) | 0;
      Atomics.store(cells, 1, state);
    }
    return Atomics.load(cells, 1);
  },
);

const benchmark = (name: string, sample: Sample): Row => {
  for (let index = 0; index < WARMUP_COUNT; index++) sample();

  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index++) samples.push(sample());

  return {
    name,
    nsPerOperation: median(samples) / ITERATIONS,
    relativeToInt32: 0,
  };
};

const main = () => {
  const pairs: BenchmarkPair[] = [
    {
      int32Name: "dynamic mask read (non-atomic)",
      int32Sample: int32NormalRead,
      candidatePrefix: "BigInt64",
      candidateName: "dynamic mask read (non-atomic)",
      candidateSample: bigint64NormalRead,
    },
    {
      int32Name: "dynamic mask read + Number XOR",
      int32Sample: int32NormalXor,
      candidatePrefix: "BigInt64",
      candidateName: "dynamic mask read + BigInt XOR",
      candidateSample: bigint64NormalXor,
    },
    {
      int32Name: "Atomics.load",
      int32Sample: int32Load,
      candidatePrefix: "BigInt64",
      candidateName: "Atomics.load",
      candidateSample: bigint64Load,
    },
    {
      int32Name: "Atomics.store (fixed value)",
      int32Sample: int32Store,
      candidatePrefix: "BigInt64",
      candidateName: "Atomics.store (fixed value)",
      candidateSample: bigint64Store,
    },
    {
      int32Name: "toggle local state + Atomics.store",
      int32Sample: int32ToggleAndStore,
      candidatePrefix: "BigInt64",
      candidateName: "toggle local state + Atomics.store",
      candidateSample: bigint64ToggleAndStore,
    },
    {
      int32Name: "Atomics.xor (atomic RMW)",
      int32Sample: int32AtomicXor,
      candidatePrefix: "BigInt64",
      candidateName: "Atomics.xor (atomic RMW)",
      candidateSample: bigint64AtomicXor,
    },
    {
      int32Name: "Number shadow + Atomics.xor",
      int32Sample: int32NumberShadowAndAtomicXor,
      candidatePrefix: "BigInt64",
      candidateName: "Number shadow + Atomics.xor",
      candidateSample: bigint64NumberShadowAndAtomicXor,
    },
    {
      int32Name: "Atomics.load + select highest lane",
      int32Sample: int32LoadAndSelectHighLane,
      candidatePrefix: "BigInt64",
      candidateName: "BigInt shift + Number + select lane 63",
      candidateSample: bigint64LoadAndSelectHighLane,
    },
    {
      int32Name: "Atomics.load + select highest lane",
      int32Sample: int32LoadAndSelectHighLane,
      candidatePrefix: "BigInt64",
      candidateName: "atomic load + local Int32 clz lane 63",
      candidateSample: bigint64LoadAndBitcastSelectHighLane,
    },
    {
      int32Name: "toggle local state + Atomics.store",
      int32Sample: int32ToggleAndStore,
      candidatePrefix: "Split Int32",
      candidateName: "toggle + store high half",
      candidateSample: twoInt32ToggleAndStoreHighLane,
    },
    {
      int32Name: "Atomics.load + select highest lane",
      int32Sample: int32LoadAndSelectHighLane,
      candidatePrefix: "Split Int32",
      candidateName: "load + select lane 63",
      candidateSample: twoInt32LoadAndSelectHighLane,
    },
  ];

  const rows: Row[] = [];
  for (const pair of pairs) {
    const int32 = benchmark(`Int32: ${pair.int32Name}`, pair.int32Sample);
    const candidate = benchmark(
      `${pair.candidatePrefix}: ${pair.candidateName}`,
      pair.candidateSample,
    );
    int32.relativeToInt32 = 1;
    candidate.relativeToInt32 = candidate.nsPerOperation / int32.nsPerOperation;
    rows.push(int32, candidate);
  }

  console.log(`Runtime: ${runtimeLabel}`);
  console.log(
    `Cache-line allocation: ${CACHE_LINE_BYTES} bytes; ${SAMPLE_COUNT} medians after ${WARMUP_COUNT} warmups; ${ITERATIONS.toLocaleString("en-US")} operations/sample.`,
  );
  console.log("");
  const caseWidth = Math.max("Case".length, ...rows.map((row) => row.name.length));
  console.log(`${"Case".padEnd(caseWidth)}  ns/op    vs Int32`);
  console.log(`${"-".repeat(caseWidth)}  -----------------`);
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(caseWidth)}  ${format(row.nsPerOperation).padStart(7)}  ${format(row.relativeToInt32, 2).padStart(7)}x`,
    );
  }

  (globalThis as { __bigint64AtomicsBenchSink?: typeof sink }).__bigint64AtomicsBenchSink = sink;
};

main();
