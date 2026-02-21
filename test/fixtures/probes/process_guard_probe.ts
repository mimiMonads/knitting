import { createPool } from "../../../knitting.ts";
import {
  attemptProcessExit,
  attemptProcessKill,
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
  attemptProcessExit,
  attemptProcessKill,
  passthroughNumber,
});

const expectGuardedReject = async (
  promise: Promise<unknown>,
  methodName: string,
) => {
  try {
    await withTimeout(promise, 1_000);
    console.error("probe-missing-guard", methodName);
    process.exit(2);
  } catch (error) {
    const text = String(error);
    if (!text.includes("KNT_ERROR_PROCESS_GUARD")) {
      console.error("probe-wrong-guard-error", methodName, text);
      process.exit(3);
    }
    if (!text.includes(methodName)) {
      console.error("probe-missing-method-name", methodName, text);
      process.exit(4);
    }
  }
};

try {
  await expectGuardedReject(pool.call.attemptProcessExit(), "process.exit");
  await expectGuardedReject(pool.call.attemptProcessKill(), "process.kill");

  const value = await withTimeout(pool.call.passthroughNumber(9), 1_000);
  if (value !== 9) {
    console.error("probe-wrong-followup-value", value);
    process.exit(5);
  }

  console.log("probe-ok process-guard");
  process.exit(0);
} finally {
  await pool.shutdown();
}
