import { createPool } from "../../../knitting.ts";
import {
  passthroughNumber,
  returnPoisonedConstructorObject,
  returnReflectPoisonedConstructorObject,
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
  returnPoisonedConstructorObject,
  returnReflectPoisonedConstructorObject,
  passthroughNumber,
});

const isSafeObject = (value: unknown) => {
  if (value == null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== true) return false;
  return Object.prototype.hasOwnProperty.call(record, "constructor") === false;
};

const expectResolvedSafe = async (promise: Promise<unknown>) => {
  try {
    const value = await withTimeout(promise, 1_000);
    return isSafeObject(value);
  } catch {
    return false;
  }
};

try {
  const resolved = await expectResolvedSafe(
    pool.call.returnPoisonedConstructorObject(),
  );

  if (!resolved) {
    console.error("probe-missing-safe-resolution");
    process.exit(2);
  }

  const reflectedResolved = await expectResolvedSafe(
    pool.call.returnReflectPoisonedConstructorObject(),
  );

  if (!reflectedResolved) {
    console.error("probe-missing-safe-reflect-resolution");
    process.exit(4);
  }

  const value = await withTimeout(pool.call.passthroughNumber(42), 1_000);
  if (value !== 42) {
    console.error("probe-wrong-followup-value", value);
    process.exit(3);
  }

  console.log("probe-ok constructor-poisoning-neutralized-and-worker-alive");
  process.exit(0);
} finally {
  await pool.shutdown();
}
