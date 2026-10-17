import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  createUnravelController,
  createUnravelShared,
  erlangCap,
  hasWorkerCpuClock,
  resolveUnravelOptions,
  type UnravelSample,
  unravelSharedBytes,
} from "../src/worker/unravel.ts";
import type { UnravelOptions } from "../src/types.ts";

/** A controller on a hand-driven wall clock and busy clock. */
const harness = (
  options?: UnravelOptions,
  shared = createUnravelShared(new SharedArrayBuffer(unravelSharedBytes(1)), 0),
  threadCpu = false,
) => {
  const clock = { wall: 0, busy: 0 };
  const samples: UnravelSample[] = [];
  const c = createUnravelController({
    options,
    shared,
    now: () => clock.wall,
    busy: () => clock.busy,
    threadCpu,
    onUpdate: (sample) => samples.push(sample),
  });
  return { c, clock, samples };
};

/** Start an async task as the dispatcher does; returns its settle token. */
const begin = (c: ReturnType<typeof harness>["c"]) => {
  c.start();
  return c.asyncStarted();
};

/** W/C of the pool estimate this worker published. */
const ratio = (c: ReturnType<typeof harness>["c"]) => {
  const e = c.estimate()!;
  return e.wait / e.cpu;
};

/**
 * One worker, k tasks in a closed loop: each waits `wait` ms, then needs
 * `cpu` ms of the worker, served first-ready first. A finished task is
 * resubmitted at once, so the worker always holds k.
 */
const repairman = (
  { c, clock }: ReturnType<typeof harness>,
  k: number,
  wait: number,
  cpu: number,
  completions: number,
) => {
  const ready: Array<[number, number]> = [];
  for (let i = 0; i < k; i++) ready.push([clock.wall + wait, begin(c)]);
  for (let done = 0; done < completions; done++) {
    ready.sort((a, b) => a[0] - b[0]);
    const [next, token] = ready.shift()!;
    if (next > clock.wall) clock.wall = next;
    clock.wall += cpu;
    clock.busy += cpu;
    c.settle(k - 1, token);
    ready.push([clock.wall + wait, begin(c)]);
  }
};

test("Unravel options validate and keep their defaults", () => {
  assert.deepEqual(resolveUnravelOptions(), {
    maxTasks: 256, minTasks: 1, initialTasks: 2, growth: 2, tickMs: 1, epsilon: .01, ceiling: true, floor: true,
  });
  assert.equal(resolveUnravelOptions({ growth: 0 }).growth, 0);
  for (const bad of [
    { growth: 1 }, { growth: -2 }, { growth: 2.5 }, { tickMs: 0 }, { tickMs: Infinity }, { epsilon: 1 },
    { maxTasks: 0 }, { maxTasks: 65_537 }, { minTasks: 4, maxTasks: 2 }, { initialTasks: 0 },
    { ceiling: "yes" }, { floor: 1 },
  ]) {
    assert.throws(() => resolveUnravelOptions(bad as UnravelOptions), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => resolveUnravelOptions(null as unknown as UnravelOptions), TypeError);
  assert.equal(erlangCap(.5, .01, 256), 4);
  assert.equal(erlangCap(Infinity, .01, 9), 9);
  assert.equal(erlangCap(1e6, .01, 256), 256);
});

test("Unravel shared state rejects bad layouts and pools published estimates by weight", () => {
  const buffer = new SharedArrayBuffer(unravelSharedBytes(2));
  assert.throws(() => createUnravelShared(buffer, 2), RangeError);
  assert.throws(() => createUnravelShared(new SharedArrayBuffer(12), 0), RangeError);
  const [a, b] = [createUnravelShared(buffer, 0), createUnravelShared(buffer, 1)];
  assert.equal(a.isWarm(), false);
  assert.equal(a.ratio(), undefined);
  a.markCold(1000.5);
  b.markCold(2000);
  assert.equal(b.coldSince(), 1000.5, "the first start wins the cold clock");
  a.publish(20, 10, 1);
  b.publish(80, 2, 3);
  assert.equal(b.isWarm(), true);
  // Weighted mean W over weighted mean C, as one pool-wide EWMA would be.
  assert.equal(a.ratio(), (20 + 3 * 80) / (10 + 3 * 2));
});

test("Unravel cold slow start doubles per tick of pool time, under the population share", () => {
  const { c, clock } = harness();
  begin(c);
  begin(c);
  assert.equal(c.getLimit(), 2);
  assert.equal(c.coldGrow(38, 2, 4), false, "the share grows to 21, the cold cap is still 2");
  clock.wall = 1;
  assert.equal(c.coldGrow(38, 2, 4), true);
  assert.equal(c.getLimit(), 4);
  clock.wall = 3.5;
  c.coldGrow(38, 2, 4);
  assert.equal(c.getLimit(), 16);
  clock.wall = 5;
  c.coldGrow(38, 2, 4);
  assert.equal(c.getLimit(), 21, "the slow start never exceeds the share");
  assert.equal(c.isCold(), true);

  const jump = harness({ growth: 0 });
  begin(jump.c);
  begin(jump.c);
  assert.equal(jump.c.coldGrow(38, 2, 4), true);
  assert.equal(jump.c.getLimit(), 21, "growth 0 admits the share at once");
});

test("Unravel cold clock is pool-wide: a late worker starts at the cap the pool has earned", () => {
  const buffer = new SharedArrayBuffer(unravelSharedBytes(2));
  const a = harness(undefined, createUnravelShared(buffer, 0));
  const b = harness(undefined, createUnravelShared(buffer, 1));
  const first = begin(a.c);
  begin(a.c);
  a.clock.wall = b.clock.wall = 30;
  begin(b.c);
  begin(b.c);
  assert.equal(b.c.coldGrow(36, 2, 4), true);
  assert.equal(b.c.getLimit(), 20, "30 ticks have passed: the share binds at once");

  // The first awaited settle anywhere ends the cold phase for every worker.
  a.clock.wall = b.clock.wall = 41;
  a.clock.busy = 1;
  a.c.settle(1, first);
  assert.equal(a.c.isCold(), false);
  assert.deepEqual(a.c.estimate(), { wait: 40, cpu: 1 });
  b.c.coldGrow(36, 2, 4);
  assert.equal(b.c.isCold(), false, "b reads a's published estimate");
  assert.equal(b.c.getLimit(), 40, "b: floor(W/C) of a's estimate");
});

test("Unravel W is a lower bound that ready-queue time cannot inflate", () => {
  for (const [k, wait, cpu] of [[1, .5, 1], [1, 40, 1], [2, 10, 1], [8, 40, 1]]) {
    const h = harness();
    repairman(h, k!, wait!, cpu!, 64);
    const { wait: w, cpu: c } = h.c.estimate()!;
    assert(Math.abs(c - cpu!) < 1e-9, `k=${k}: C ${c}`);
    // A task that becomes ready while the worker serves another loses that
    // part of its wait: at most the k - 1 services ahead of it.
    assert(w <= wait! + 1e-9 && w >= wait! - (k! - 1) * cpu!, `k=${k} W=${wait}: estimate ${w}`);
  }
  // A cold burst that starts and waits together is read exactly.
  const burst = harness();
  const tokens = Array.from({ length: 7 }, () => begin(burst.c));
  burst.clock.wall = 20;
  for (const token of tokens) {
    burst.clock.wall += 10;
    burst.clock.busy += 10;
    burst.c.settle(6, token);
  }
  assert.deepEqual(burst.c.estimate(), { wait: 20, cpu: 10 });
  // Ten tasks behind 1 ms of CPU each, 0.5 ms of wait: after the first
  // 0.5 ms the worker never idles. Residence per completion is 10 ms, so
  // (R - C) / C would read 9; the queueing is not wait, and the estimate
  // falls to zero instead.
  const saturated = harness();
  repairman(saturated, 10, .5, 1, 64);
  assert(ratio(saturated.c) < .01, `saturated W/C ${ratio(saturated.c)}`);
});

test("Unravel does not read the wall time a thread CPU clock loses while busy as idle", () => {
  for (const threadCpu of [false, true]) {
    const { c, clock } = harness(undefined, undefined, threadCpu);
    const first = begin(c), second = begin(c);
    // Both tasks wait 10 ms, then each continuation runs for 2 ms of wall
    // time, of which the clock loses 40 µs to interrupts.
    clock.wall += 12;
    clock.busy += 1.96;
    c.settle(1, first);
    clock.wall += 2;
    clock.busy += 1.96;
    c.settle(0, second);
    const { wait } = c.estimate()!;
    if (threadCpu) assert(wait <= 10, `W ${wait} stays a lower bound`);
    else assert(wait > 10, `an exact busy clock reads the 40 µs gap as idle: W ${wait}`);
  }
});

test("Unravel's real busy clock keeps W a lower bound behind queued continuations", {
  skip: !hasWorkerCpuClock(),
}, async () => {
  // Default clocks. A busy clock that advances only on scheduler ticks reads
  // the queueing behind earlier continuations as idle and inflates W.
  const c = createUnravelController();
  const wall = () => performance.timeOrigin + performance.now();
  const spin = (ms: number) => {
    const until = performance.now() + ms;
    while (performance.now() < until) {}
  };
  let longestWait = 0;
  for (let round = 0; round < 8; round++) {
    const started = wall();
    const tokens = Array.from({ length: 4 }, () => begin(c));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Every task is ready by now; the later ones only queue behind earlier
    // continuations, which is not wait.
    longestWait = Math.max(longestWait, wall() - started);
    for (let i = 0; i < 4; i++) {
      spin(2);
      c.settle(3 - i, tokens[i]);
    }
  }
  const { wait, cpu } = c.estimate()!;
  // Slack for descheduling, which a thread CPU clock counts as idle.
  assert(wait <= longestWait + 1, `W ${wait} ms exceeds the longest true wait ${longestWait} ms`);
  assert(cpu > 1 && cpu < 3, `C ${cpu} ms for 2 ms continuations`);
});

test("Unravel warm ceiling binds expensive continuations below the share", () => {
  const h = harness();
  repairman(h, 1, .5, 1, 16);
  const { c } = h;
  assert.equal(c.isCold(), false);
  assert.equal(ratio(c), .5);
  begin(c);
  assert.equal(c.coldGrow(60, 1, 2), true);
  assert.equal(c.getLimit(), 4, "K(0.5) at epsilon .01, not the share of 62");
});

test("Unravel floor admits cheap continuations above the share", () => {
  const h = harness();
  repairman(h, 1, 40, 1, 16);
  const { c } = h;
  c.settle(0);
  assert.equal(c.getLimit(), 40, "drained: the share is back to 2, floor(W/C) is 40");
  const off = harness({ floor: false });
  repairman(off, 1, 40, 1, 16);
  off.c.settle(0);
  assert.equal(off.c.getLimit(), 2);
});

test("Unravel warm probe doubles after a tick idle at the cap and resets when the worker drains", () => {
  const h = harness();
  repairman(h, 1, .5, 1, 16);
  const { c, clock, samples } = h;
  begin(c);
  c.coldGrow(60, 1, 2);
  for (let i = 0; i < 2; i++) begin(c);
  assert.equal(c.getLimit(), 4);
  assert.equal(c.coldGrow(60, 1, 4), false, "the first look only starts the idle clock");
  clock.wall += .5;
  assert.equal(c.coldGrow(60, 1, 4), false, "less than a tick");
  clock.wall += .5;
  assert.equal(c.coldGrow(60, 1, 4), true);
  assert.equal(c.getLimit(), 8);
  assert.equal(samples.at(-1)!.reason, "probe");
  for (let i = 0; i < 4; i++) begin(c);
  c.coldGrow(60, 1, 8);
  clock.wall += 1;
  clock.busy += 1;
  assert.equal(c.coldGrow(60, 1, 8), false, "busy for the whole tick is not idle evidence");
  clock.wall += 1;
  c.coldGrow(60, 1, 8);
  assert.equal(c.getLimit(), 16);
  c.settle(0);
  assert.equal(c.getLimit(), 2, "draining drops the probe and the share");

  const off = harness({ ceiling: false });
  repairman(off, 1, .5, 1, 16);
  begin(off.c);
  off.c.coldGrow(60, 1, 2);
  assert.equal(off.c.getLimit(), 62, "without the ceiling the cap is the share");
});

test("Unravel excludes synchronous work from C", () => {
  const { c, clock } = harness();
  const token = begin(c);
  // A 20 ms synchronous call while the async task waits is not its CPU.
  clock.wall += 10;
  const started = c.start();
  clock.wall += 20;
  clock.busy += 20;
  c.exclude(started);
  clock.wall += 10;
  clock.wall += 1;
  clock.busy += 1;
  c.settle(0, token);
  assert.deepEqual(c.estimate(), { wait: 40, cpu: 1 });
});

test("Unravel probe accumulates idle across starts and settles, excluding busy time", () => {
  const h = harness();
  repairman(h, 1, .5, 1, 16);
  const { c, clock } = h;
  begin(c);
  c.coldGrow(60, 1, 2);
  let token = begin(c);
  begin(c);
  c.coldGrow(60, 1, 4);
  assert.equal(c.getLimit(), 4);

  for (let i = 0; i < 3; i++) {
    clock.wall += .4;
    clock.wall += .6;
    clock.busy += .6;
    c.settle(3, token);
    token = begin(c);
    c.coldGrow(60, 1, 4);
    assert.equal(c.getLimit(), i < 2 ? 4 : 8,
      "one tick of cumulative idle, despite a settle and refill every .4 ms of idle");
  }

  // Fill the new slots and arm the next probe. Arbitrarily long busy
  // periods must not spend another tick or reuse the previous idle credit.
  for (let i = 0; i < 4; i++) begin(c);
  c.coldGrow(60, 1, 8);
  clock.wall += 20;
  clock.busy += 20;
  c.coldGrow(60, 1, 8);
  assert.equal(c.getLimit(), 8);
});

test("Unravel probe stops at the share and discards idle credit when queued work disappears", () => {
  const shared = createUnravelShared(new SharedArrayBuffer(unravelSharedBytes(1)), 0);
  shared.publish(.5, 1, 8);
  const { c, clock, samples } = harness({ floor: false }, shared);
  begin(c);
  begin(c);
  c.coldGrow(6, 1, 2);
  begin(c);
  begin(c);
  c.coldGrow(4, 1, 4);
  clock.wall += .75;
  c.coldGrow(0, 1, 4);
  clock.wall += 10;
  c.coldGrow(4, 1, 4);
  assert.equal(c.getLimit(), 4, "idle with no queue earns no probe credit");
  clock.wall += .75;
  c.coldGrow(4, 1, 4);
  assert.equal(c.getLimit(), 4, "the earlier partial tick was discarded");
  clock.wall += .25;
  c.coldGrow(4, 1, 4);
  assert.equal(c.getLimit(), 8, "doubling reaches the population share");
  assert.equal(samples.at(-1)!.probe, 8);

  c.settle(0);
  begin(c);
  begin(c);
  c.coldGrow(4, 1, 2);
  begin(c);
  begin(c);
  c.coldGrow(2, 1, 4);
  assert.equal(c.getLimit(), 4, "draining resets the earned probe");
});

test("Unravel earned probes shrink with the ceiling after waits shorten", () => {
  const shared = createUnravelShared(new SharedArrayBuffer(unravelSharedBytes(1)), 0);
  shared.publish(40, 1, 8);
  const { c, clock, samples } = harness({ floor: false }, shared);
  begin(c);
  begin(c);
  c.coldGrow(200, 1, 2);
  const k = erlangCap(40, .01, 256);
  assert.equal(c.getLimit(), k);
  for (let i = 2; i < k; i++) begin(c);
  c.coldGrow(202 - k, 1, k);
  clock.wall += 1;
  c.coldGrow(202 - k, 1, k);
  assert.equal(c.getLimit(), 2 * k);

  shared.publish(.5, 1, 8);
  c.coldGrow(202 - k, 1, k);
  assert.equal(c.getLimit(), 8, "the earned 2x allowance follows K from the long-wait phase to K(.5)=4");
  assert.equal(samples.at(-1)!.probe, 8, "traces report the effective probe");
  assert.equal(samples.at(-1)!.reason, "grow", "lowering the cap never reports newly earned idle credit");
});
