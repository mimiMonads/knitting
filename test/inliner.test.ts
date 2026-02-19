import assert from "node:assert/strict";
import test from "node:test";
const assertEquals: (actual: unknown, expected: unknown) => void =
  (actual, expected) => {
    assert.deepStrictEqual(actual, expected);
  };
import { createPool } from "../knitting.ts";
import { genTaskID } from "../src/common/others.ts";
import { createInlineExecutor } from "../src/runtime/inline-executor.ts";
import { hello, world } from "./fixtures/hello_world.ts";
import { laneFlag } from "./fixtures/inliner_threshold.ts";

test("inliner awaits promise arguments before invoking task", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    inliner: { position: "last" },
    balancer: "roundRobin",
  })({ hello, world });

  try {
    const warmup = call.world("warmup");
    const result = await call.world(call.hello());
    await warmup;
    assertEquals(result, "hello  world!");
  } finally {
    await shutdown();
  }
});

test("inliner resolves first dispatch in microtasks", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    inliner: { position: "first", batchSize: 1 },
    balancer: "roundRobin",
  })({ hello });

  try {
    let settled = false;
    const pending = call.hello().then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    assertEquals(settled, true);
    await pending;
  } finally {
    await shutdown();
  }
});

test("inliner over batch limit yields remaining work to macrotasks", async () => {
  const inliner = createInlineExecutor({
    tasks: { hello },
    genTaskID,
    batchSize: 1,
  });
  const invoke = inliner.call({ fnNumber: 0 });

  try {
    let firstSettled = false;
    let secondSettled = false;

    const first = invoke(undefined).then(() => {
      firstSettled = true;
    });
    const second = invoke(undefined).then(() => {
      secondSettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    assertEquals(firstSettled, true);
    assertEquals(secondSettled, false);

    await Promise.all([first, second]);
  } finally {
    await inliner.kills();
  }
});

test("shutdown rejects pending inliner calls", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    inliner: { position: "first" },
    balancer: "roundRobin",
  })({ world });

  const never = new Promise<string>(() => {});
  const pending = call.world(never);

  await shutdown();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const status = await Promise.race([
    pending.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise<string>((resolve) => {
      timeoutId = setTimeout(() => resolve("pending"), 250);
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  assertEquals(status, "rejected");
});

test("inliner.dispatchThreshold keeps inline lane idle below threshold", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    balancer: "roundRobin",
    inliner: {
      position: "last",
      dispatchThreshold: 32,
    },
  })({ laneFlag });

  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => call.laneFlag(20)),
    );

    assertEquals(results.every((value) => value === false), true);
  } finally {
    await shutdown();
  }
});

test("inliner.dispatchThreshold allows inline lane once threshold is reached", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    balancer: "roundRobin",
    inliner: {
      position: "last",
      dispatchThreshold: 2,
    },
  })({ laneFlag });

  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call.laneFlag(20)),
    );
    assert(results.some((value) => value === true));
    assert(results.some((value) => value === false));
  } finally {
    await shutdown();
  }
});
