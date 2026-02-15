import { assert, assertEquals } from "jsr:@std/assert";
import { createPool } from "../knitting.ts";
import { hello, world } from "./fixtures/hello_world.ts";
import { laneFlag } from "./fixtures/inliner_threshold.ts";

Deno.test("inliner awaits promise arguments before invoking task", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    inliner: { position: "last" },
    balancer: "robinRound",
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

Deno.test("shutdown rejects pending inliner calls", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    inliner: { position: "first" },
    balancer: "robinRound",
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

Deno.test("inliner.dispatchThreshold keeps inline lane idle below threshold", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    balancer: "robinRound",
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

Deno.test("inliner.dispatchThreshold allows inline lane once threshold is reached", async () => {
  const { call, shutdown } = createPool({
    threads: 1,
    balancer: "robinRound",
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
