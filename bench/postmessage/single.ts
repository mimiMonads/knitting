import { Worker } from "node:worker_threads";
import { withResolvers } from "../../src/common/with-resolvers.ts";

const workerCode = `
  const { parentPort } = require("node:worker_threads");

  parentPort.on("message", ({ id, payload }) => {
    try {
      parentPort.postMessage({ id, result: payload });
    } catch (error) {
      parentPort.postMessage({ id, error: String(error?.message ?? error) });
    }
  });
`;

type Deferred = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type MessageWorker = Worker & {
  on(
    event: "message",
    listener: (
      message: { id: number; result?: unknown; error?: string },
    ) => void,
  ): MessageWorker;
};

export const createWorkerPool = (threads: number) => {
  if (!Number.isSafeInteger(threads) || threads < 1) {
    throw new Error("worker pool size must be a positive integer");
  }

  const workers = Array.from(
    { length: threads },
    (_, workerId) =>
      new Worker(workerCode, {
        eval: true,
        name: `echo-worker-${workerId}`,
      }) as MessageWorker,
  );
  const pending = new Map<number, Deferred>();
  let nextId = 0;
  let nextWorker = 0;
  let closed = false;

  for (const worker of workers) {
    worker.on(
      "message",
      (message: { id: number; result?: unknown; error?: string }) => {
        const deferred = pending.get(message.id);
        if (deferred === undefined) return;
        pending.delete(message.id);

        if (message.error !== undefined) {
          deferred.reject(new Error(message.error));
        } else {
          deferred.resolve(message.result);
        }
      },
    );
  }

  const call = (payload?: unknown) => {
    if (closed) throw new Error("worker pool is closed");

    const id = nextId++;
    const deferred = withResolvers();
    pending.set(id, deferred);
    workers[nextWorker]!.postMessage({ id, payload });
    nextWorker = (nextWorker + 1) % workers.length;
    return deferred.promise;
  };

  const shutdown = async () => {
    if (closed) return;
    closed = true;
    const error = new Error("worker pool shut down with pending calls");
    for (const deferred of pending.values()) deferred.reject(error);
    pending.clear();
    await Promise.all(workers.map((worker) => worker.terminate()));
  };

  return { call, shutdown };
};
