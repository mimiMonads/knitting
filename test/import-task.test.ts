import assert from "node:assert/strict";
import test from "node:test";
import { addOneViaImportTask } from "./fixtures/runtime_tasks.ts";

test("importTask placeholder throws when called directly", () => {
  assert.throws(
    () => addOneViaImportTask.f(10),
    /cannot be called directly/,
  );
});
