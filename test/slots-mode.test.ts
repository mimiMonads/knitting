import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { concat, double } from "./fixtures/steal_tasks.ts";
import { abortReturnsInput } from "./fixtures/abort_tasks.ts";

const modes = [
  { threads: 1, host: { slots: 64 as const, stallFreeLoops: 0 } },
  {
    threads: 4,
    host: {
      slots: 64 as const,
      steal: false,
      dispatcher: "per-thread" as const,
      stallFreeLoops: 0,
    },
  },
  {
    threads: 4,
    host: {
      slots: 64 as const,
      steal: false,
      dispatcher: "serial-channel" as const,
      stallFreeLoops: 0,
    },
  },
  {
    threads: 4,
    host: {
      slots: 64 as const,
      steal: true,
      stealClaim: "ticket" as const,
      stealRegionLanes: 64,
      stallFreeLoops: 0,
    },
  },
  {
    threads: 4,
    host: {
      slots: 64 as const,
      steal: true,
      stealClaim: "ticket" as const,
      stealRegionLanes: 1,
      stallFreeLoops: 0,
    },
  },
  {
    threads: 4,
    host: {
      slots: 64 as const,
      steal: true,
      stealClaim: "dekker" as const,
      stealRegionLanes: 2,
      stallFreeLoops: 0,
    },
  },
  {
    threads: 4,
    host: {
      slots: 64 as const,
      steal: true,
      stealClaim: "dekker" as const,
      stallFreeLoops: 0,
    },
  },
];

for (const options of modes) {
  const topology = options.host.stealClaim ?? options.host.dispatcher ??
    "single";
  test(
    `64-slot public pool completes repeated concurrent calls (${topology}, lanes=${
      options.host.stealRegionLanes ?? "default"
    })`,
    { timeout: 15000 },
    async () => {
      const pool = createPool(options)({ double, concat });
      try {
        for (let round = 0; round < 3; round++) {
          const values = await Promise.all(
            Array.from(
              { length: 300 },
              (_, i) => pool.call.double(round * 300 + i),
            ),
          );
          assert.deepEqual(
            values,
            Array.from({ length: 300 }, (_, i) => 2 * (round * 300 + i)),
          );
          // Fill both static halves and exercise the independent 64-region arena.
          const texts = Array.from(
            { length: 80 },
            (_, i) => `r${round}-${i}:` + "x".repeat(i & 1 ? 2048 : 16),
          );
          const returned = await Promise.all(
            texts.map((text) => pool.call.concat(text)),
          );
          assert.deepEqual(
            returned,
            texts.map((text) => `${text}!`),
          );
        }
      } finally {
        await pool.shutdown();
      }
    },
  );
}

test("public pools reject invalid task slot widths", () => {
  for (const slots of [0, 16, 48, 65, "64"]) {
    assert.throws(
      () => createPool({ host: { slots: slots as never } })({ double }),
      /host.slots must be 32 or 64/,
    );
  }
});

test("pools reject abort capacities that would wrap task signal metadata", () => {
  for (const slots of [32, 64] as const) {
    for (const threads of [1, 3]) {
      assert.throws(() =>
        createPool({
          threads,
          host: { slots, steal: threads > 1 },
          abortSignalCapacity: 65536,
        })({ abortReturnsInput }), /abortSignalCapacity must be <= 65535/);
    }
  }
});

for (const claim of ["private", "ticket", "dekker"] as const) {
  test(
    `64-slot ${claim} pools keep abort signals independent across both halves and reuse`,
    { timeout: 15000 },
    async () => {
      const pool = createPool({
        threads: claim === "private" ? 1 : 3,
        abortSignalCapacity: 64,
        host: {
          slots: 64,
          steal: claim !== "private",
          stealClaim: claim === "private" ? undefined : claim,
          stallFreeLoops: 0,
        },
      })({ abortReturnsInput, double });
      const bounded = async <T>(promise: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("abort signal test timed out")),
                5000,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      try {
        for (let round = 0; round < 2; round++) {
          const values = Array.from(
            { length: 64 },
            (_, i) => `signal-${round}-${i}:` + "x".repeat(2048),
          );
          const settled = new Set<number>();
          const calls = values.map((value, i) => {
            const call = pool.call.abortReturnsInput(value);
            void call.then(() => settled.add(i), () => {});
            return call;
          });
          // Signal allocation alternates between bitmap words. Aborting the
          // even calls must leave the other 32 signals untouched.
          const selected = calls.filter((_, i) => (i & 1) === 0);
          for (const call of selected) call.reject();
          assert.deepEqual(
            await bounded(Promise.all(selected)),
            values.filter((_, i) => (i & 1) === 0),
          );
          assert([...settled].every((i) => (i & 1) === 0));

          // Reuse the released signal identities while the un-aborted calls
          // remain live. Recycled flags must not abort an unrelated old call.
          const replacements = Array.from(
            { length: 32 },
            (_, i) => pool.call.abortReturnsInput(`reuse-${round}-${i}`),
          );
          for (const call of replacements) {
            call.reject();
          }
          assert.deepEqual(
            await bounded(Promise.all(replacements)),
            Array.from({ length: 32 }, (_, i) => `reuse-${round}-${i}`),
          );
          assert([...settled].every((i) => (i & 1) === 0));
          for (let i = 1; i < calls.length; i += 2) calls[i]!.reject();
          assert.deepEqual(await bounded(Promise.all(calls)), values);
          assert.equal(await bounded(pool.call.double(21)), 42);
        }
      } finally {
        await pool.shutdown();
      }
    },
  );
}
