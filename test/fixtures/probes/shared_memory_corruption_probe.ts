import { createPool } from "../../../knitting.ts";
import {
  corruptSharedMemoryViaWorkerData,
  passthroughNumber,
} from "../fault_tasks.ts";

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`test timeout after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

const pool = createPool({
  threads: 1,
  worker: process.platform === "win32" ? { timers: { parkMs: 0 } } : undefined,
})({
  corruptSharedMemoryViaWorkerData,
  passthroughNumber,
});

// The host doorbell recovers a missed completion wake on a 1s watchdog, so a
// budget under that turns one late wake into a probe failure. This asks
// whether the pool still works, not how fast, so leave the watchdog room.
const CALL_TIMEOUT_MS = 1_500;

try {
  let blocked = false;

  try {
    await withTimeout(
      pool.call.corruptSharedMemoryViaWorkerData(),
      CALL_TIMEOUT_MS,
    );
  } catch (_error) {
    blocked = true;
  }

  if (!blocked) {
    console.error("probe-mitigation-missing");
    process.exit(2);
  }

  for (let i = 0; i < 20; i++) {
    const value = await withTimeout(
      pool.call.passthroughNumber(i),
      CALL_TIMEOUT_MS,
    );
    if (value !== i) {
      console.error("probe-worker-corrupted");
      process.exit(3);
    }
  }

  console.log("probe-ok shared-memory-protected");
  process.exit(0);
} finally {
  await pool.shutdown();
}
