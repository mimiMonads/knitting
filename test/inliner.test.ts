import { assertEquals } from "jsr:@std/assert";
import { createPool } from "../knitting.ts";
import { hello, world } from "./fixtures/hello_world.ts";

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
