import assert from "node:assert/strict";
import test from "./_runner.ts";
import { taskToHostMicros } from "../bench/util/doorbell-clock.ts";

test("doorbell benchmark retains delays at and beyond watchdog recovery", () => {
  const stamp = 1000 * 100 * 2 + 1;
  assert.equal(taskToHostMicros(stamp, 2000), 1_000_000);
  assert.equal(taskToHostMicros(stamp, 5000), 4_000_000);
});

test("doorbell clock tolerates stamp rounding but rejects incompatible clocks", () => {
  const stamp = 1000 * 100 * 2;
  assert.equal(taskToHostMicros(stamp, 999.995), 0);
  assert.equal(taskToHostMicros(stamp, 900), undefined);
  assert.equal(taskToHostMicros(Number.NaN, 1000), undefined);
});
