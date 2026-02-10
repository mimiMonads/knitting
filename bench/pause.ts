import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { format, print } from "./ulti/json-parse.ts";

export const ping = task<number, number>({
  f: (value) => value + 1,
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const BIG_PAUSE_NS = Number(process.env.PAUSE_NS ?? "2000000000");
const MODE = process.env.PAUSE_MODE ?? "both";

const createScenario = (pauseNanoseconds: number) =>
  createPool({
    threads: 1,
    worker: {
      timers: {
        spinMicroseconds: 200,
        parkMs: 1,
        pauseNanoseconds,
      },
    },
    host: {
      stallFreeLoops: 0,
      maxBackoffMs: 1,
    },
  })({ ping });

if (isMain) {
  const noPause = createScenario(0);
  const pauseBig = createScenario(BIG_PAUSE_NS);
  const burstSize = 64;

  const runSingle = async (
    scenario: ReturnType<typeof createScenario>,
    value: number,
  ) => {
    const pending = scenario.call.ping(value);
    await pending;
  };

  const runBurst = async (
    scenario: ReturnType<typeof createScenario>,
    count: number,
  ) => {
    const pending = Array.from({ length: count }, (_, i) => scenario.call.ping(i));
    await Promise.all(pending);
  };

  const runIdleWake = async (
    scenario: ReturnType<typeof createScenario>,
    gapMs: number,
  ) => {
    const pending = scenario.call.ping(1);
    await pending;
    await delay(gapMs);
  };

  group(`atomics.pause (0ns vs ${BIG_PAUSE_NS}ns)`, () => {
    if (MODE === "both" || MODE === "off") {
      bench("single call (0ns)", async () => await runSingle(noPause, 1));
      bench(`burst ${burstSize} (0ns)`, async () => await runBurst(noPause, burstSize));
      bench("idle wake 1ms (0ns)", async () => await runIdleWake(noPause, 1));
    }
    if (MODE === "both" || MODE === "on") {
      bench(`single call (${BIG_PAUSE_NS}ns)`, async () => await runSingle(pauseBig, 1));
      bench(
        `burst ${burstSize} (${BIG_PAUSE_NS}ns)`,
        async () => await runBurst(pauseBig, burstSize),
      );
      bench(
        `idle wake 1ms (${BIG_PAUSE_NS}ns)`,
        async () => await runIdleWake(pauseBig, 1),
      );
    }
  });

  await mitataRun({ format, print });
  await Promise.all([noPause.shutdown(), pauseBig.shutdown()]);
}
