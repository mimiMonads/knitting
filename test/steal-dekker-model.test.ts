import assert from "node:assert/strict";
import test from "./_runner.ts";

/**
 * Sequentially consistent model of the shipped, global-ID Dekker handshake.
 *
 * Selection is omitted: allowing every consumer to attempt the same region
 * over-approximates the candidate prefilter. All consumers are live. Each
 * declaration, peer read, and intent clear is a separate transition. A
 * conflicting senior read goes to `withdraw`, so another consumer can run
 * before the failed claimant clears its intent in the runtime's backoff path.
 *
 * Runtime-to-model correspondence in src/memory/lock.ts:
 *   store WANT                -> idle -> senior
 *   senior loop (IDs < self)  -> senior -> senior / withdraw
 *   clear after conflict      -> withdraw -> done
 *   initial junior scan       -> junior -> junior / wait / inside
 *   stealJuniorWants()         -> wait; restart at self+1 on conflict
 *   clear after decoding/ACK  -> inside -> done
 *
 * Constant LIVE reads and local branches are omitted. No batch retention is
 * modelled: the shipped code decodes one snapshot. ACK generations, payloads,
 * and death are exercised by runtime tests, not this exclusion model. The
 * finite search with repeated attempts proves neither starvation freedom nor
 * arbitrary weak-memory correctness. Tests in lock-steal.test.ts separately
 * verify that the runtime really rechecks seniors in global-ID order.
 */
type Phase =
  | "idle"
  | "senior"
  | "withdraw"
  | "junior"
  | "wait"
  | "inside"
  | "done";
type Local = { phase: Phase; index: number; want: boolean };
type State = Local[];

const key = (state: State): string =>
  state.map((local) => `${local.phase}:${local.index}:${Number(local.want)}`)
    .join("|");

const step = (
  state: State,
  c: number,
  seniorSkipsJuniors: boolean,
): State => {
  const me = state[c]!;
  const next = state.map((local) => ({ ...local }));
  const mine = next[c]!;
  switch (me.phase) {
    case "idle":
      mine.want = true;
      mine.phase = "senior";
      mine.index = 0;
      return next;
    case "senior":
      if (me.index === c) {
        mine.phase = "junior";
        mine.index = seniorSkipsJuniors && c === 0 ? state.length : c + 1;
      } else if (state[me.index]!.want) {
        // This read does not clear WANT. Withdrawal is a later atomic store.
        mine.phase = "withdraw";
      } else {
        mine.index++;
      }
      return next;
    case "withdraw":
      mine.want = false;
      mine.phase = "done";
      return next;
    case "junior":
    case "wait":
      if (me.index === state.length) {
        mine.phase = "inside";
        mine.index = 0;
      } else if (state[me.index]!.want) {
        // The initial scan breaks on conflict. Every subsequent helper scan
        // restarts at the first junior, rather than waiting on one peer alone.
        mine.phase = "wait";
        mine.index = c + 1;
      } else {
        mine.index++;
      }
      return next;
    case "inside":
      mine.want = false;
      mine.phase = "done";
      return next;
    case "done":
      mine.phase = "idle";
      mine.index = 0;
      return next;
  }
};

const explore = (consumers: number, seniorSkipsJuniors = false) => {
  const initial: State = Array.from({ length: consumers }, () => ({
    phase: "idle",
    index: 0,
    want: false,
  }));
  const queue: State[] = [initial];
  const seen = new Set([key(initial)]);
  const entered = new Set<number>();
  let delayedWithdrawals = 0;
  let violation: State | undefined;

  for (let head = 0; head < queue.length; head++) {
    const state = queue[head]!;
    if (state.filter((local) => local.phase === "inside").length > 1) {
      violation = state;
      break;
    }
    if (state.some((local) => local.phase === "withdraw" && local.want)) {
      delayedWithdrawals++;
    }
    for (let c = 0; c < consumers; c++) {
      if (state[c]!.phase === "inside") entered.add(c);
      const next = step(state, c, seniorSkipsJuniors);
      const nextKey = key(next);
      if (seen.has(nextKey)) continue;
      seen.add(nextKey);
      queue.push(next);
    }
  }
  return { states: seen.size, entered, delayedWithdrawals, violation };
};

for (const consumers of [3, 4]) {
  test(`global-ID Dekker excludes concurrent entry with ${consumers} consumers`, () => {
    const { states, entered, delayedWithdrawals, violation } = explore(
      consumers,
    );
    assert.equal(
      violation,
      undefined,
      `exclusion violated: ${JSON.stringify(violation)}`,
    );
    assert.deepEqual(
      [...entered].sort(),
      Array.from({ length: consumers }, (_, c) => c),
    );
    assert.equal(states > 200, true, `search collapsed to ${states} states`);
    assert.equal(
      delayedWithdrawals > 0,
      true,
      "must explore delayed intent-clear schedules",
    );
  });
}

test("a senior that skips its junior survey breaks exclusion", () => {
  const { violation } = explore(3, true);
  assert.notEqual(violation, undefined);
  assert.equal(
    violation!.filter((local) => local.phase === "inside").length > 1,
    true,
  );
});
