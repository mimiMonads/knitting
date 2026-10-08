import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  ChannelHandler,
  hostDispatcherLoop,
} from "../src/runtime/dispatcher.ts";

for (const pump of ["auto", "channel"] as const) {
  test(`${pump} pump coalesces lane notifications and allows a subsequent turn`, async () => {
    const channel = new ChannelHandler(pump);
    let calls = 0;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => finish = resolve);
    channel.open(() => {
      calls++;
      if (calls === 1) {
        for (let lane = 0; lane < 8; lane++) channel.notify();
      } else {
        finish();
      }
    });
    try {
      for (let lane = 0; lane < 8; lane++) channel.notify();
      await finished;
      // Drain queued callbacks before asserting the count.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(calls, 2);
    } finally {
      channel.close();
    }
  });

  test(`${pump} pump ignores a queued callback after close`, async () => {
    const channel = new ChannelHandler(pump);
    let calls = 0;
    channel.open(() => calls++);
    channel.notify();
    channel.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 0);
  });
}

test("process completion doorbell drains directly without a channel hop", () => {
  let active = true;
  let completed = 0;
  let channelNotifies = 0;
  const channel = {
    notify: () => channelNotifies++,
  } as unknown as ChannelHandler;
  const words = new Int32Array(3);
  const { wakeCompletion } = hostDispatcherLoop({
    signalBox: {
      opView: words.subarray(0, 1),
      txStatus: words.subarray(1, 2),
      rxStatus: words.subarray(2, 3),
    } as never,
    queue: {
      completeFrame: () => {
        if (!active) return 0;
        active = false;
        completed++;
        return 1;
      },
      hasPendingFrames: () => false,
      flushToWorker: () => false,
      txIdle: () => !active,
      waitForCompletion: () => false,
      armCompletionNotifier: () => true,
      setCompletionWaiterArmed: () => {},
    } as never,
    channelHandler: channel,
    crossProcess: true,
    processCompletionDoorbell: true,
  });

  wakeCompletion();

  assert.equal(completed, 1);
  assert.equal(channelNotifies, 0);
});

for (const transport of ["process", "native"] as const) {
  test(`a lost ${transport} doorbell resolves a published result after the watchdog`, async () => {
    let channelNotifies = 0;
    let published = false;
    let active = true;
    let waiterArmed = false;
    let completed = 0;
    let resolveCall!: (value: number) => void;
    const call = new Promise<number>((resolve) => resolveCall = resolve);
    const channel = {
      notify: () => {
        channelNotifies++;
        queueMicrotask(check);
      },
    } as unknown as ChannelHandler;
    const words = new Int32Array(3);
    const { check } = hostDispatcherLoop({
      signalBox: {
        opView: words.subarray(0, 1),
        txStatus: words.subarray(1, 2),
        rxStatus: words.subarray(2, 3),
      } as never,
      queue: {
        completeFrame: () => {
          if (!active || !published) return 0;
          active = false;
          completed++;
          resolveCall(42);
          return 1;
        },
        hasPendingFrames: () => false,
        flushToWorker: () => false,
        txIdle: () => !active,
        waitForCompletion: () => false,
        armCompletionNotifier: () => {
          waiterArmed = true;
          return true;
        },
        setCompletionWaiterArmed: (armed: boolean) => waiterArmed = armed,
      } as never,
      channelHandler: channel,
      dispatcherOptions: { stallFreeLoops: 0 },
      crossProcess: transport === "process",
      processCompletionDoorbell: transport === "process",
      nativeCompletionDoorbell: transport === "native",
    });

    check.isRunning = true;
    check();
    assert.equal(channelNotifies, 0, "the arm must wait for a ring first");
    assert.equal(waiterArmed, true);

    // Publish after arming, without delivering any completion event.
    published = true;
    const started = performance.now();
    // The watchdog is unref'd; this deadline keeps the test process alive.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("result stayed parked")),
            3_000,
          );
        }),
      ]);
      assert.equal(result, 42);
    } finally {
      clearTimeout(deadline);
      active = false;
      check();
    }
    assert.equal(channelNotifies, 1, "the host stayed parked on a lost ring");
    assert.equal(completed, 1);
    assert.equal(waiterArmed, false);
    assert.equal(check.isRunning, false);
    assert.ok(performance.now() - started >= 900, "the watchdog fired early");
  });
}

test("a delivered process ring cancels its watchdog", async () => {
  let active = true;
  let published = false;
  let channelNotifies = 0;
  const words = new Int32Array(3);
  const { check, wakeCompletion } = hostDispatcherLoop({
    signalBox: {
      opView: words.subarray(0, 1),
      txStatus: words.subarray(1, 2),
      rxStatus: words.subarray(2, 3),
    } as never,
    queue: {
      completeFrame: () => {
        if (!active || !published) return 0;
        active = false;
        return 1;
      },
      hasPendingFrames: () => false,
      flushToWorker: () => false,
      txIdle: () => !active,
      waitForCompletion: () => false,
      armCompletionNotifier: () => true,
      setCompletionWaiterArmed: () => {},
    } as never,
    channelHandler: {
      notify: () => channelNotifies++,
    } as unknown as ChannelHandler,
    dispatcherOptions: { stallFreeLoops: 0 },
    crossProcess: true,
    processCompletionDoorbell: true,
  });
  check.isRunning = true;
  check();
  published = true;
  wakeCompletion();
  assert.equal(active, false, "the ring must drain immediately");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(
    channelNotifies,
    0,
    "a cancelled watchdog must not schedule another pass",
  );
});

test("a completion that wins a native arm drains without a channel hop", () => {
  let published = true;
  let armObserved = false;
  let completed = 0;
  let channelNotifies = 0;
  const channel = {
    notify: () => channelNotifies++,
  } as unknown as ChannelHandler;
  const words = new Int32Array(3);
  const { check } = hostDispatcherLoop({
    signalBox: {
      opView: words.subarray(0, 1),
      txStatus: words.subarray(1, 2),
      rxStatus: words.subarray(2, 3),
    } as never,
    queue: {
      completeFrame: () => {
        if (!published || !armObserved) return 0;
        published = false;
        completed++;
        return 1;
      },
      hasPendingFrames: () => false,
      flushToWorker: () => false,
      txIdle: () => !published,
      waitForCompletion: () => false,
      armCompletionNotifier: () => (armObserved = true, false),
      setCompletionWaiterArmed: () => {},
    } as never,
    channelHandler: channel,
    dispatcherOptions: { stallFreeLoops: 0 },
    nativeCompletionDoorbell: true,
  });

  check.isRunning = true;
  check();

  assert.equal(completed, 1);
  assert.equal(channelNotifies, 0);
});
