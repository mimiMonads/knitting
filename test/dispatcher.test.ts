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
