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

const pool = createPool({ threads: 1 })({
  corruptSharedMemoryViaWorkerData,
  passthroughNumber,
});

try {
  let blocked = false;

  try {
    await withTimeout(pool.call.corruptSharedMemoryViaWorkerData(), 500);
  } catch (_error) {
    blocked = true;
  }

  if (!blocked) {
    console.error("probe-mitigation-missing");
    process.exit(2);
  }

  for (let i = 0; i < 20; i++) {
    const value = await withTimeout(pool.call.passthroughNumber(i), 200);
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
