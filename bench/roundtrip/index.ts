const BATCH_SIZE = 100;
const SAMPLE_COUNT = 7;
const WARMUP_COUNT = 2;

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

type RoundtripSample = {
  batchNs: number;
  roundtripNs: number;
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

const sinkBox = { value: 0 };

const createScenario = async () => {
  const worker = await createWorker();
  const pending = new Map<
    number,
    { resolve: (value: number) => void; reject: (error: unknown) => void }
  >();
  let nextId = 1;

  const detach = listenToWorker(
    worker,
    (message) => {
      if (!message || typeof message !== "object") return;
      const payload = message as {
        type?: string;
        id?: number;
        value?: number;
        message?: string;
        stack?: string;
      };

      if (payload.type === "result" && typeof payload.id === "number") {
        const entry = pending.get(payload.id);
        if (!entry) return;
        pending.delete(payload.id);
        entry.resolve(payload.value ?? 0);
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

  const terminate = async () => {
    detach();
    pending.clear();
    await worker.terminate?.();
  };

  const runBatch = async (): Promise<RoundtripSample> => {
    const promises: Promise<number>[] = [];
    const started = nowNs();

    for (let i = 0; i < BATCH_SIZE; i++) {
      const id = nextId++;
      const promise = new Promise<number>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      promises.push(promise);
      worker.postMessage({
        type: "echo",
        id,
        value: i,
      });
    }

    const values = await Promise.all(promises);
    let checksum = 0;
    for (const value of values) checksum += value;

    const batchNs = nowNs() - started;
    sinkBox.value ^= checksum;
    return {
      batchNs,
      roundtripNs: batchNs / BATCH_SIZE,
    };
  };

  return {
    runBatch,
    close: terminate,
  };
};

const percentile = (sorted: number[], ratio: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index]!;
};

const statsFor = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg: samples.length === 0 ? 0 : total / samples.length,
    p50: percentile(sorted, 0.50),
  };
};

const printTable = (samples: RoundtripSample[]): void => {
  const batchStats = statsFor(samples.map((sample) => sample.batchNs));
  const roundtripStats = statsFor(samples.map((sample) => sample.roundtripNs));

  const rows = [[
    `postMessage echo (batch ${formatInt(BATCH_SIZE)})`,
    formatNs(batchStats.p50),
    formatNs(roundtripStats.p50),
    formatInt(1_000_000_000 / roundtripStats.p50),
  ]];
  const headers = ["Benchmark", "Median batch ns", "Median ns/rt", "Rts/sec"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length))
  );

  console.log(`Runtime: ${runtimeLabel}`);
  console.log(
    `Samples: ${SAMPLE_COUNT} measured runs after ${WARMUP_COUNT} warmups`,
  );
  console.log(`Batch size: ${formatInt(BATCH_SIZE)}`);
  console.log("");
  console.log(headers.map((header, index) => padRight(header, widths[index]!)).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
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

const run = async (): Promise<void> => {
  const scenario = await createScenario();
  try {
    for (let i = 0; i < WARMUP_COUNT; i++) {
      await scenario.runBatch();
    }

    const samples: RoundtripSample[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      samples.push(await scenario.runBatch());
    }

    printTable(samples);
  } finally {
    await scenario.close();
  }

  (globalThis as { __roundtripSink?: number }).__roundtripSink = sinkBox.value;
};

try {
  await run();
} catch (error) {
  const message = error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
  console.error("roundtrip benchmark failed:", message);
  throw error;
}
