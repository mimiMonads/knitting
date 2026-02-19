import assert from "node:assert/strict";
import test from "node:test";
const assertEquals: (actual: unknown, expected: unknown) => void =
  (actual, expected) => {
    assert.deepStrictEqual(actual, expected);
  };
import RingQueue from "../src/ipc/tools/RingQueue.ts";

test("shiftNoClear preserves FIFO order and size accounting", () => {
  const q = new RingQueue<number>(4);
  q.push(1);
  q.push(2);
  q.push(3);

  assertEquals(q.shiftNoClear(), 1);
  assertEquals(q.size, 2);

  q.push(4);
  assertEquals(q.toArray(), [2, 3, 4]);
});

test("growth keeps logical order after wrap-around", () => {
  const q = new RingQueue<number>(4);

  q.push(0);
  q.push(1);
  q.push(2);
  q.push(3);

  assertEquals(q.shiftNoClear(), 0);
  assertEquals(q.shiftNoClear(), 1);

  q.push(4);
  q.push(5);
  assertEquals(q.toArray(), [2, 3, 4, 5]);

  // triggers growth from 4 -> 8 with wrapped layout present
  q.push(6);
  assertEquals(q.toArray(), [2, 3, 4, 5, 6]);
  assertEquals(q.capacity >= 8, true);
});
