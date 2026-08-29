import { parentPort, workerData } from "node:worker_threads";
import { createNodeCompletionNotifier } from "../../src/runtime/node-doorbell.ts";

const data = workerData as { pointer?: string } | undefined;
if (typeof data?.pointer !== "string") {
  throw new Error("Node doorbell worker needs a pointer");
}

const notify = createNodeCompletionNotifier(BigInt(data.pointer));
parentPort?.postMessage({ notifier: notify !== undefined });
notify?.();
