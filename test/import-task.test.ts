import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool, importTask } from "../knitting.ts";
import { failViaImportTask } from "./fixtures/runtime_tasks.ts";

test("an imported export is called directly once its module has loaded", async () => {
  const href = "./fixtures/imported_functions.ts";
  const addOne = importTask<number, number>({ href, name: "addOne" });
  const addOneLater = importTask<number, number>({ href, name: "addOneLater" });

  const first = addOne.f(1);
  assert.ok(first instanceof Promise, "the first call loads the module");
  assert.equal(await first, 2);
  // A sync export now returns a plain value, so a worker never counts it as
  // awaiting; an async export still returns its own promise.
  assert.equal(addOne.f(2), 3);
  assert.equal(await addOneLater.f(0), 1);
  const later = addOneLater.f(1);
  assert.ok(later instanceof Promise);
  assert.equal(await later, 2);
});

test("an imported sync export that throws rejects every call", async () => {
  const pool = createPool({ threads: 1, worker: { maxAwaitingTasks: 1 } })({
    failViaImportTask,
  });
  try {
    // The first call rejects through the module load, later ones through a
    // synchronous throw.
    for (const message of ["first call", "second call", "third call"]) {
      await assert.rejects(pool.call.failViaImportTask(message), {
        message,
      });
    }
  } finally {
    await pool.shutdown();
  }
});
