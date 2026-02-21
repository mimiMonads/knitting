import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../knitting.ts";

test("createPool rejects more than Uint16 function ids", () => {
  const tasks: Record<string, unknown> = {};
  const noop = (value: unknown) => value;

  for (let i = 0; i <= 0x10000; i++) {
    tasks[`task_${i}`] = {
      f: noop,
      id: i,
      at: i,
      importedFrom: "file:///tmp/knitting_fake_tasks.ts",
    };
  }

  assert.throws(
    () => {
      createPool({ threads: 1 })(tasks as any);
    },
    /Too many tasks/,
  );
});
