import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { format, print } from "./util/json-parse.ts";

/**
 * How host dispatch cost scales with worker count.
 *
 * The host runs one dispatcher check per lane per tick. Under the
 * `serial-channel` dispatcher every lane used to be visited on every tick, so a
 * single in-flight call paid N checks (and N Atomics.notify wakes) for N
 * workers — latency grew with thread count even though the work did not.
 *
 * Sweep it with:
 *   for t in 1 2 4 6; do for d in per-thread serial-channel; do \
 *     KNITTING_DISPATCHER=$d DISPATCHER_SCALING_THREADS=$t \
 *     node --experimental-transform-types bench/dispatcher-scaling.ts; done; done
 */
export const echo = task<number, number>({
  f: (value) => value,
});

const THREADS = Number(process.env.DISPATCHER_SCALING_THREADS ?? "4");
const FANOUTS = (process.env.DISPATCHER_SCALING_FANOUTS ?? "1,8,64")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 1);

// This benchmark isolates the private-lane dispatcher. Work-stealing behavior
// has dedicated harnesses under bench/steal/.
const pool = createPool({ threads: THREADS, host: { steal: false } })({ echo });

if (isMain) {
  const dispatcher = process.env.KNITTING_DISPATCHER ?? "auto";
  const call = pool.call.echo;

  group(`dispatcher=${dispatcher} threads=${THREADS}`, () => {
    for (const fanout of FANOUTS) {
      if (fanout === 1) {
        // The lane count should not matter here: one call, one busy lane.
        bench("in flight 1", async () => {
          await call(1);
        });
        continue;
      }

      bench(`in flight ${fanout}`, async () => {
        const pending = new Array<Promise<number>>(fanout);
        for (let index = 0; index < fanout; index++) {
          pending[index] = call(index);
        }
        await Promise.all(pending);
      });
    }
  });

  await mitataRun({
    format,
    print,
  });

  await pool.shutdown();
}
