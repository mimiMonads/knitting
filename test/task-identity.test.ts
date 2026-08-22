import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { stableTaskID } from "../src/common/task-source.ts";
// Import order here is deliberate and load-bearing: the decoy module first, the
// partner module second. The worker imports task modules in task-name order
// ("partner" before "wanted"), so it reaches these two modules the other way
// round. Anything that numbers tasks as it imports them disagrees across that
// boundary.
import { decoyOne, decoyTwo, wanted } from "./fixtures/task_id_decoys.ts";
import { partner } from "./fixtures/task_id_partner.ts";

type TaskIdentity = { id: number; at: number; importedFrom: string };

const identityOf = (task: unknown): TaskIdentity => task as TaskIdentity;

/**
 * A task id has to name a task, not the moment its module happened to be
 * evaluated. Host and worker do not share an import order, so an id minted from
 * a process-global counter means something different on each side, and the
 * worker's `ids.includes(obj.id)` selection then picks a different set of tasks
 * than the pool registered.
 *
 * `(importedFrom, at)` is the same pair in every process: `at` counts `task()`
 * calls within one module, so it is fixed by source order.
 */
test("task ids are derived from module identity, not import order", () => {
  for (const entry of [decoyOne, decoyTwo, wanted, partner]) {
    const { id, at, importedFrom } = identityOf(entry);
    assert.equal(
      id,
      stableTaskID(importedFrom, at),
      `task id ${id} is not derived from (${importedFrom}, ${at}); ` +
        "an import-order-dependent id desyncs the host from its workers",
    );
  }
});

/** Distinct tasks must stay distinguishable, including across modules. */
test("task ids stay distinct across modules that share an `at`", () => {
  const decoy = identityOf(decoyOne);
  const other = identityOf(partner);
  assert.equal(decoy.at, other.at, "fixture drift: both should be `at` 0");
  assert.notEqual(
    decoy.importedFrom,
    other.importedFrom,
    "fixture drift: these must live in different modules",
  );
  assert.notEqual(
    decoy.id,
    other.id,
    "two tasks in different modules collided on one id",
  );
});

/**
 * The symptom, end to end. `partner` and `wanted` come from different modules,
 * and the decoys ahead of `wanted` shift that module's numbering. When host and
 * worker disagree on ids the worker silently selects `decoyTwo` — a task this
 * pool never registered — and `partner` answers with its value instead. No
 * throw, no crash, just the wrong number.
 */
test("a pool spanning two modules runs the tasks it registered", async () => {
  const pool = createPool({ threads: 1 })({ wanted, partner });
  try {
    assert.equal(await pool.call.wanted(21), 42);

    const answer = await pool.call.partner(21);
    assert.notEqual(
      answer,
      -222,
      "`partner` executed decoyTwo: the worker resolved pool task ids " +
        "against its own import order",
    );
    assert.notEqual(
      answer,
      -111,
      "`partner` executed decoyOne: the worker resolved pool task ids " +
        "against its own import order",
    );
    assert.equal(answer, 1021);
  } finally {
    await pool.shutdown();
  }
});
