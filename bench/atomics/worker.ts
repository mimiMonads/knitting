const isNode =
  typeof process !== "undefined" &&
  typeof process.versions?.node === "string";

const nowNs = isNode && typeof process.hrtime?.bigint === "function"
  ? () => Number(process.hrtime.bigint())
  : () => performance.now() * 1_000_000;

const ARMED_CELL = 0;
const WAIT_CELL = 1;
const ACK_CELL = 2;

const setupMessaging = async (): Promise<{
  postMessage: (value: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => void;
}> => {
  if (isNode) {
    const { parentPort } = await import("node:worker_threads");
    if (parentPort == null) {
      throw new Error("worker_threads parentPort is not available");
    }
    return {
      postMessage: (value) => parentPort.postMessage(value),
      onMessage: (handler) => {
        parentPort.on("message", handler);
      },
    };
  }

  const scope = globalThis as {
    postMessage?: (value: unknown) => void;
    onmessage?: (event: { data?: unknown }) => void;
    self?: {
      postMessage?: (value: unknown) => void;
      onmessage?: (event: { data?: unknown }) => void;
    };
  };
  const workerGlobal = scope.self ?? scope;

  return {
    postMessage: (value) => {
      const post = workerGlobal.postMessage ?? scope.postMessage;
      if (typeof post !== "function") {
        throw new Error("postMessage is not available in this worker");
      }
      post.call(workerGlobal, value);
    },
    onMessage: (handler) => {
      workerGlobal.onmessage = (event) => handler(event.data);
    },
  };
};

const { postMessage, onMessage } = await setupMessaging();

onMessage(async (message) => {
  try {
    if (!message || typeof message !== "object") return;
    const payload = message as {
      type?: string;
      id?: number;
      rounds?: number;
      sab?: SharedArrayBuffer;
    };

    if (payload.type !== "run" || typeof payload.id !== "number") {
      return;
    }

    if (typeof payload.rounds !== "number" || payload.sab == null) {
      throw new Error("Invalid benchmark payload");
    }

    const cells = new Int32Array(payload.sab);
    cells[ARMED_CELL] = 0;
    cells[WAIT_CELL] = 0;
    cells[ACK_CELL] = 0;

    const started = nowNs();
    for (let round = 1; round <= payload.rounds; round++) {
      const waiter = Atomics.waitAsync(cells, WAIT_CELL, 0);
      if (!waiter.async) {
        throw new Error("Atomics.waitAsync returned synchronously");
      }

      Atomics.store(cells, ARMED_CELL, round);
      Atomics.notify(cells, ARMED_CELL, 1);

      await waiter.value;

      Atomics.store(cells, ACK_CELL, round);
      Atomics.notify(cells, ACK_CELL, 1);
    }
    const waitNs = nowNs() - started;

    postMessage({
      type: "result",
      id: payload.id,
      waitNs,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    postMessage({
      type: "error",
      id: (message as { id?: number } | null)?.id,
      message: err.message,
      stack: err.stack,
    });
  }
});
