import { createPool } from "../../../knitting.ts";
import {
  passthroughNumber,
  returnForgedBufferReferencePayload,
  returnForgedSharedArrayBufferPayload,
  returnSpeciesPoisonedArray,
  returnSpeciesPoisonedNumericArray,
  returnSpeciesPoisonedUint8Array,
} from "../fault_tasks.ts";

type Settled =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: unknown }
  | { status: "timed-out" };

const withOutcome = async <T>(
  promise: Promise<T>,
  ms: number,
): Promise<Settled> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): Settled => ({ status: "fulfilled", value }),
        (reason): Settled => ({ status: "rejected", reason }),
      ),
      new Promise<Settled>((resolve) => {
        timeoutId = setTimeout(() => resolve({ status: "timed-out" }), ms);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const expectFulfilled = async (
  label: string,
  promise: Promise<unknown>,
  predicate: (value: unknown) => boolean,
  code: number,
) => {
  const outcome = await withOutcome(promise, 1_000);
  if (outcome.status !== "fulfilled" || !predicate(outcome.value)) {
    console.error(`${label}-unexpected`, outcome);
    process.exit(code);
  }
};

const expectRejected = async (
  label: string,
  promise: Promise<unknown>,
  code: number,
) => {
  const outcome = await withOutcome(promise, 1_000);
  if (outcome.status !== "rejected") {
    console.error(`${label}-not-rejected`, outcome);
    process.exit(code);
  }
};

const pool = createPool({
  threads: 1,
  worker: process.platform === "win32" ? { timers: { parkMs: 0 } } : undefined,
})({
  passthroughNumber,
  returnForgedBufferReferencePayload,
  returnForgedSharedArrayBufferPayload,
  returnSpeciesPoisonedArray,
  returnSpeciesPoisonedNumericArray,
  returnSpeciesPoisonedUint8Array,
});

try {
  await expectFulfilled(
    "species-array",
    pool.call.returnSpeciesPoisonedArray(),
    (value) =>
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === 1 &&
      value[2] === 3,
    2,
  );

  await expectFulfilled(
    "species-numeric-array",
    pool.call.returnSpeciesPoisonedNumericArray(),
    (value) =>
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === 4 &&
      value[2] === 6,
    3,
  );

  await expectRejected(
    "species-uint8array",
    pool.call.returnSpeciesPoisonedUint8Array(),
    4,
  );

  await expectRejected(
    "forged-shared-array-buffer",
    pool.call.returnForgedSharedArrayBufferPayload(),
    5,
  );

  await expectRejected(
    "forged-buffer-reference",
    pool.call.returnForgedBufferReferencePayload(),
    6,
  );

  const followup = await withOutcome(pool.call.passthroughNumber(42), 1_000);
  if (followup.status !== "fulfilled" || followup.value !== 42) {
    console.error("followup-unexpected", followup);
    process.exit(7);
  }

  console.log("probe-ok worker-poisoning-neutralized-and-host-alive");
  process.exit(0);
} finally {
  await pool.shutdown();
}
