import { Worker } from "node:worker_threads";

const workerCode = `
  import { parentPort } from 'node:worker_threads';

  // function simulation
  const fn = (arg) => arg


  parentPort.on('message', ({ id, payload }) => {
    try {
      // your real logic goes here. we just echo back:
      parentPort.postMessage(fn({ id, result: payload }));
    } catch (err) {
      parentPort.postMessage({ id, error: (err instanceof Error ? err.message : String(err)) });
    }
  });
`;

const worker = new Worker(workerCode, {
  eval: true,
  type: "module",
  name: "echo-worker",
});

type Deferred = {
  resolve: (value: unknown) => void;
  reject: (reason?: any) => void;
};

const map = new Map<number, Deferred>();

// message handler: either resolve or reject the right promise
worker.on(
  "message",
  (msg: { id: number; result?: unknown; error?: string }) => {
    const entry = map.get(msg.id);
    if (!entry) return;
    map.delete(msg.id);

    if (msg.error != null) {
      entry.reject(new Error(msg.error));
    } else {
      entry.resolve(msg.result);
    }
  },
);

let nextId = 0;

export function toResolve(message) {
  const id = nextId++;
  const def = Promise.withResolvers();
  map.set(id, def);
  worker.postMessage({ id, payload: message });
  return def.promise;
}

export { worker };
