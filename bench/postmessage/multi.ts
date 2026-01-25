import { Worker } from "node:worker_threads";
import { withResolvers } from "../../src/common/with-resolvers.ts";

// ─── Worker Code ──────────────────────────────────────────────────────────────
const workerCode = `
  import { parentPort } from 'node:worker_threads';

  const fn = async (arg) => arg; // Simulated function

  parentPort.on('message', async ({ id, payload }) => {
    try {
      parentPort.postMessage(await fn({ id, result: payload }));
    } catch (err) {
      parentPort.postMessage({
        id,
        error: (err instanceof Error ? err.message : String(err))
      });
    }
  });
`;

// ─── Types ────────────────────────────────────────────────────────────────────
type Deferred = {
  resolve: (value: unknown) => void;
  reject: (reason?: any) => void;
};

type Message = {
  id: number;
  payload?: unknown;
};

type Response = {
  id: number;
  result?: unknown;
  error?: string;
};

// ─── State ────────────────────────────────────────────────────────────────────
const WORKER_COUNT = 4;
const workers: Worker[] = [];
const maps: Map<number, Deferred>[] = Array.from(
  { length: WORKER_COUNT },
  () => new Map(),
);
let nextId = 0;
let nextWorkerIndex = 0;

// ─── Worker Creation and Listener Binding ─────────────────────────────────────
for (let i = 0; i < WORKER_COUNT; i++) {
  const worker = new Worker(workerCode, {
    eval: true,
    type: "module",
    name: `worker-${i}`,
  });

  const map = maps[i];

  worker.on("message", (msg: Response) => {
    const entry = map.get(msg.id);
    if (!entry) return;
    map.delete(msg.id);

    if (msg.error != null) {
      entry.reject(new Error(msg.error));
    } else {
      entry.resolve(msg.result);
    }
  });

  workers.push(worker);
}

// ─── Public API: Round-Robin Message Dispatch ────────────────────────────────
export function toResolve(payload?: unknown): Promise<unknown> {
  const id = nextId++;
  const def = withResolvers();

  const index = nextWorkerIndex++ % WORKER_COUNT;
  maps[index].set(id, def);
  workers[index].postMessage({ id, payload });

  return def.promise;
}

// ─── Public API: Graceful Termination ────────────────────────────────────────
export async function shutdownWorkers(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.terminate()));
}
