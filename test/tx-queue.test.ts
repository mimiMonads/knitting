import assert from "node:assert/strict";
import test from "node:test";
import { TASK_SLOT_META_VALUE_MASK, getTaskSlotMeta, type Lock2, type Task } from "../src/memory/lock.ts";
import { createHostTxQueue } from "../src/runtime/tx-queue.ts";

const makeQueue = () => {
  const seen: number[] = [];
  let nowValue = 0;
  const lock = {
    encode: (task: Task) => {
      seen.push(getTaskSlotMeta(task));
      return true;
    },
    encodeManyFrom: () => 0,
  } as unknown as Lock2;

  const returnLock = {
    resolveHost: () => () => 0,
  } as unknown as Lock2;

  return {
    seen,
    setNow: (value: number) => {
      nowValue = value;
    },
    tx: createHostTxQueue({
      lock,
      returnLock,
      max: 1,
      now: () => nowValue,
    }),
  };
};

test("tx enqueue encodes timeout into slotBuffer upper bits", () => {
  const { seen, setNow, tx } = makeQueue();
  const callWithoutTimeout = tx.enqueue(0);
  void callWithoutTimeout("a");

  setNow(128);
  const callWithZeroTimeout = tx.enqueue(0, 0);
  void callWithZeroTimeout("b");

  setNow(96_001);
  const callWithObject = tx.enqueue(0, { time: 5, maybe: true });
  void callWithObject("c");

  assert.equal(seen[0], 0);
  assert.equal(seen[1], 128 & TASK_SLOT_META_VALUE_MASK);
  assert.equal(seen[2], 96_001 & TASK_SLOT_META_VALUE_MASK);
});
