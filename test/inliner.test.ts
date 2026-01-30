import { assertEquals } from "jsr:@std/assert";
import { createPool, task } from "../knitting.ts";

export const hello = task({
  f: () => "hello ",
});

export const world = task({
  f: (args: string) => args + " world!",
});

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
