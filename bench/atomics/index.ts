const MICRO_ITERATIONS = 5_000_000;
const WAIT_ROUNDS = 10_000;
const SAMPLE_COUNT = 5;
const WARMUP_COUNT = 2;

const ARMED_CELL = 0;
const WAIT_CELL = 1;
const ACK_CELL = 2;
const CELL_COUNT = 3;

const isNode =
  typeof process !== "undefined" &&
  typeof process.versions?.node === "string";

const runtimeLabel = isNode
  ? `node ${process.version}`
  : typeof globalThis.__andromeda__ !== "undefined"
  ? "andromeda"
  : "unknown";

const nowNs = isNode && typeof process.hrtime?.bigint === "function"
  ? () => Number(process.hrtime.bigint())
  : () => performance.now() * 1_000_000;

const withThousands = (value: string): string => {
  if (value.length <= 3) return value;
  let out = "";
  let group = 0;
  for (let i = value.length - 1; i >= 0; i--) {
    out = value[i]! + out;
    group++;
    if (group === 3 && i !== 0) {
      out = "," + out;
      group = 0;
    }
  }
  return out;
};

const formatInt = (value: number): string =>
  withThousands(Math.round(value).toString());

const formatNs = (value: number): string => {
  const rounded = value.toFixed(1);
  const [whole, fraction] = rounded.split(".");
  return `${withThousands(whole)}.${fraction ?? "0"}`;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const padRight = (value: string, width: number): string =>
  value + " ".repeat(Math.max(0, width - value.length));

const padLeft = (value: string, width: number): string =>
  " ".repeat(Math.max(0, width - value.length)) + value;

const sinkBox = { value: 0 };

type WorkerLike = {
  postMessage: (value: unknown) => void;
  terminate?: () => unknown;
  on?: (
    event: "message" | "error",
    handler: (...args: unknown[]) => void,
  ) => void;
  off?: (
    event: "message" | "error",
    handler: (...args: unknown[]) => void,
  ) => void;
  removeListener?: (
    event: "message" | "error",
    handler: (...args: unknown[]) => void,
  ) => void;
  addEventListener?: (
    event: "message" | "error",
    handler: (event: { data?: unknown; error?: unknown }) => void,
  ) => void;
  removeEventListener?: (
    event: "message" | "error",
    handler: (event: { data?: unknown; error?: unknown }) => void,
  ) => void;
  onmessage?: ((event: { data?: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
};

type BenchmarkRow = {
  name: string;
  iterations: number;
  medianNsPerOp: number;
  medianOpsPerSec: number;
};

type WaitAsyncSample = {
  waitNs: number;
  notifyNs: number;
};

const unwrapMessage = (event: unknown): unknown => {
  if (event && typeof event === "object" && "data" in event) {
    return (event as { data?: unknown }).data;
  }
  return event;
};

const listenToWorker = (
  worker: WorkerLike,
  onMessage: (message: unknown) => void,
  onError: (error: unknown) => void,
): (() => void) => {
  if (typeof worker.on === "function") {
    const messageHandler = (message: unknown) => onMessage(message);
    const errorHandler = (error: unknown) => onError(error);
    worker.on("message", messageHandler);
    worker.on("error", errorHandler);
    return () => {
      worker.off?.("message", messageHandler);
      worker.off?.("error", errorHandler);
      worker.removeListener?.("message", messageHandler);
      worker.removeListener?.("error", errorHandler);
    };
  }

  if (typeof worker.addEventListener === "function") {
    const messageHandler = (event: { data?: unknown }) =>
      onMessage(unwrapMessage(event));
    const errorHandler = (event: { error?: unknown }) =>
      onError(event.error ?? event);
    worker.addEventListener("message", messageHandler);
    worker.addEventListener("error", errorHandler);
    return () => {
      worker.removeEventListener?.("message", messageHandler);
      worker.removeEventListener?.("error", errorHandler);
    };
  }

  const previousMessage = worker.onmessage ?? null;
  const previousError = worker.onerror ?? null;
  worker.onmessage = (event) => {
    previousMessage?.call(worker, event);
    onMessage(unwrapMessage(event));
  };
  worker.onerror = (event) => {
    previousError?.call(worker, event);
    onError(event);
  };
  return () => {
    worker.onmessage = previousMessage;
    worker.onerror = previousError;
  };
};

const createWorker = async (): Promise<WorkerLike> => {
  const workerUrl = new URL("./worker.ts", import.meta.url);
  if (isNode) {
    const { Worker } = await import("node:worker_threads");
    return new Worker(workerUrl, { type: "module" }) as WorkerLike;
  }

  const WorkerCtor = globalThis.Worker as
    | (new (url: URL, options?: { type?: "module" | "classic" }) => WorkerLike)
    | undefined;
  if (typeof WorkerCtor !== "function") {
    throw new Error("Worker is not available in this runtime");
  }
  return new WorkerCtor(workerUrl, { type: "module" });
};

const createMicroSample = (
  iterations: number,
  run: (cells: Int32Array, iterations: number) => number,
): (() => number) => {
  const cells = new Int32Array(new SharedArrayBuffer(4));
  return () => {
    const started = nowNs();
    const checksum = run(cells, iterations);
    const elapsed = nowNs() - started;
    sinkBox.value += checksum;
    return elapsed;
  };
};

const loadSample = createMicroSample(MICRO_ITERATIONS, (cells, iterations) => {
  cells[0] = 1;
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    checksum += Atomics.load(cells, 0);
  }
  return checksum;
});

const storeSample = createMicroSample(MICRO_ITERATIONS, (cells, iterations) => {
  cells[0] = 0;
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    checksum += Atomics.store(cells, 0, i);
  }
  return checksum;
});

const addSample = createMicroSample(MICRO_ITERATIONS, (cells, iterations) => {
  cells[0] = 0;
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    checksum += Atomics.add(cells, 0, 1);
  }
  return checksum;
});

const compareExchangeSample = createMicroSample(
  MICRO_ITERATIONS,
  (cells, iterations) => {
    cells[0] = 0;
    let checksum = 0;
    for (let i = 0; i < iterations; i++) {
      checksum += Atomics.compareExchange(cells, 0, i, i + 1);
    }
    return checksum;
  },
);

const createWaitAsyncScenario = async () => {
  const worker = await createWorker();
  const cells = new Int32Array(
    new SharedArrayBuffer(CELL_COUNT * Int32Array.BYTES_PER_ELEMENT),
  );
  const pending = new Map<number, { resolve: (value: WaitAsyncSample) => void; reject: (error: unknown) => void }>();
  let nextId = 1;

  const terminateWorker = async () => {
    pending.clear();
    await worker.terminate?.();
  };

  const detach = listenToWorker(
    worker,
    (message) => {
      if (!message || typeof message !== "object") return;
      const payload = message as {
        type?: string;
        id?: number;
        waitNs?: number;
        message?: string;
        stack?: string;
      };

      if (payload.type === "result" && typeof payload.id === "number") {
        const entry = pending.get(payload.id);
        if (!entry) return;
        pending.delete(payload.id);
        entry.resolve({
          waitNs: payload.waitNs ?? 0,
          notifyNs: 0,
        });
        return;
      }

      if (payload.type === "error") {
        const error = new Error(payload.message ?? "worker error");
        if (payload.stack) error.stack = payload.stack;
        for (const entry of pending.values()) {
          entry.reject(error);
        }
        pending.clear();
      }
    },
    (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const entry of pending.values()) {
        entry.reject(err);
      }
      pending.clear();
    },
  );

  const runSample = async (): Promise<WaitAsyncSample> => {
    const id = nextId++;
    cells[ARMED_CELL] = 0;
    cells[WAIT_CELL] = 0;
    cells[ACK_CELL] = 0;

    const resultPromise = new Promise<WaitAsyncSample>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });

    worker.postMessage({
      type: "run",
      id,
      rounds: WAIT_ROUNDS,
      sab: cells.buffer,
    });

    let notifyNs = 0;
    for (let round = 1; round <= WAIT_ROUNDS; round++) {
      while (Atomics.load(cells, ARMED_CELL) !== round) {
        Atomics.wait(cells, ARMED_CELL, round - 1);
      }

      const notifyStarted = nowNs();
      const woken = Atomics.notify(cells, WAIT_CELL, 1);
      notifyNs += nowNs() - notifyStarted;
      if (woken !== 1) {
        throw new Error(`Expected one waiter to wake, got ${woken}`);
      }

      while (Atomics.load(cells, ACK_CELL) !== round) {
        Atomics.wait(cells, ACK_CELL, round - 1);
      }
    }

    const result = await resultPromise;
    return {
      waitNs: result.waitNs,
      notifyNs,
    };
  };

  return {
    runSample,
    close: async () => {
      detach();
      await terminateWorker();
    },
  };
};

const summarize = (
  name: string,
  iterations: number,
  samples: number[],
): BenchmarkRow => {
  const medianSample = median(samples);
  const medianNsPerOp = medianSample / iterations;
  return {
    name,
    iterations,
    medianNsPerOp,
    medianOpsPerSec: 1_000_000_000 / medianNsPerOp,
  };
};

const runBenchmark = async (
  name: string,
  iterations: number,
  sample: () => number | Promise<number>,
): Promise<BenchmarkRow> => {
  for (let i = 0; i < WARMUP_COUNT; i++) {
    await sample();
  }

  const samples: number[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    samples.push(await sample());
  }
  return summarize(name, iterations, samples);
};

const runCombinedBenchmark = async (
  waitName: string,
  notifyName: string,
  iterations: number,
  sample: () => Promise<WaitAsyncSample>,
): Promise<BenchmarkRow[]> => {
  const waitSamples: number[] = [];
  const notifySamples: number[] = [];

  for (let i = 0; i < WARMUP_COUNT; i++) {
    await sample();
  }

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const result = await sample();
    waitSamples.push(result.waitNs);
    notifySamples.push(result.notifyNs);
  }

  return [
    summarize(waitName, iterations, waitSamples),
    summarize(notifyName, iterations, notifySamples),
  ];
};

const printRows = (rows: BenchmarkRow[]): void => {
  const headers = ["Benchmark", "Iterations", "Median ns/op", "Ops/sec"];
  const tableRows = rows.map((row) => [
    row.name,
    formatInt(row.iterations),
    formatNs(row.medianNsPerOp),
    formatInt(row.medianOpsPerSec),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index]!.length))
  );

  const headerLine = headers
    .map((header, index) => padRight(header, widths[index]!))
    .join("  ");
  const separator = widths
    .map((width) => "-".repeat(width))
    .join("  ");

  console.log(`Runtime: ${runtimeLabel}`);
  console.log(
    `Samples: ${SAMPLE_COUNT} measured runs after ${WARMUP_COUNT} warmups`,
  );
  console.log(
    "waitAsync rows report the worker's awaited time and the main-thread notify-call time from the same handshake.",
  );
  console.log("");
  console.log(headerLine);
  console.log(separator);

  for (const row of tableRows) {
    console.log(
      [
        padRight(row[0]!, widths[0]!),
        padLeft(row[1]!, widths[1]!),
        padLeft(row[2]!, widths[2]!),
        padLeft(row[3]!, widths[3]!),
      ].join("  "),
    );
  }
};

const main = async (): Promise<void> => {
  const rows: BenchmarkRow[] = [];

  rows.push(
    await runBenchmark(
      `Atomics.load (${formatInt(MICRO_ITERATIONS)} ops)`,
      MICRO_ITERATIONS,
      loadSample,
    ),
  );
  rows.push(
    await runBenchmark(
      `Atomics.store (${formatInt(MICRO_ITERATIONS)} ops)`,
      MICRO_ITERATIONS,
      storeSample,
    ),
  );
  rows.push(
    await runBenchmark(
      `Atomics.add (${formatInt(MICRO_ITERATIONS)} ops)`,
      MICRO_ITERATIONS,
      addSample,
    ),
  );
  rows.push(
    await runBenchmark(
      `Atomics.compareExchange (${formatInt(MICRO_ITERATIONS)} ops)`,
      MICRO_ITERATIONS,
      compareExchangeSample,
    ),
  );

  const waitScenario = await createWaitAsyncScenario();
  try {
    const waitAndNotifyRows = await runCombinedBenchmark(
      `Atomics.waitAsync await (${formatInt(WAIT_ROUNDS)} rounds)`,
      `Atomics.notify (${formatInt(WAIT_ROUNDS)} rounds)`,
      WAIT_ROUNDS,
      waitScenario.runSample,
    );
    rows.push(...waitAndNotifyRows);
  } finally {
    await waitScenario.close();
  }

  printRows(rows);
  (globalThis as { __atomicsBenchSink?: number }).__atomicsBenchSink = sinkBox.value;
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
  console.error("Atomics benchmark failed:", message);
  throw error;
}
