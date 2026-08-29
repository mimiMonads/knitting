import { createDenoCompletionDoorbell } from "../../../src/runtime/deno-doorbell.ts";

const doorbell = createDenoCompletionDoorbell();
if (doorbell === undefined) {
  throw new Error("Deno FFI completion doorbell is unavailable");
}

let resolve!: () => void;
const rung = new Promise<void>((done) => resolve = done);
doorbell.listen(7, resolve);
const workerUrl = new URL("../deno-doorbell-worker.ts", import.meta.url);
workerUrl.searchParams.set("pointer", String(doorbell.pointer));
workerUrl.searchParams.set("lane", "7");
const worker = new Worker(workerUrl, { type: "module" });
let resolveWorkerDone!: () => void;
const workerDone = new Promise<void>((done) => resolveWorkerDone = done);
worker.onmessage = () => resolveWorkerDone();

try {
  await Promise.race([
    rung,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Deno doorbell did not wake host")), 500);
    }),
  ]);
  await Promise.race([
    workerDone,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Deno doorbell worker did not finish")), 500);
    }),
  ]);
  console.log("deno completion doorbell ok");
} finally {
  // The worker has acknowledged that it made its last raw callback before the
  // host invalidates the callback pointer. Closing it earlier is unsafe.
  worker.terminate();
  doorbell.close();
}
