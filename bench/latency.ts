import { bench, group, run as mitataRun, summary  } from "mitata";
import { createThreadPool, fixedPoint, isMain } from "../knitting.ts";
import { terminateAllWorkers, toResolve } from "./postmessage/single.ts";

const  json = { debug: false, samples: false } 
const format = 
  process.argv.includes("--json")
  ? {
    json
  }
  : "markdown"

export const inLine = fixedPoint({
  f: async (_: void) => {},
});

const { terminateAll, callFunction, fastCallFunction, send } = createThreadPool(
  {},
)({ inLine });

if (isMain) {
  const sizes = [10, 100, 1000, 10000, 100_000];

    // ───────────────────────── worker (toResolve) ─────────────────────────
    group("worker", () => {


        bench("nop", async () => {
          const arr = Array.from({ length: 10 }, () => toResolve());
          send();
          await Promise.all(arr);
          await toResolve();
        })

        bench("1 thread (fast) → 1", async () => {
          await toResolve();
        })

        for (const n of sizes) {
          bench(`1 thread → ${n}`, async () => {
            const arr = Array.from({ length: n }, () => toResolve());
            send();
            await Promise.all(arr);
          })
        }
   
    });

    // ───────────────────────── knitting (callFunction) ────────────────────
    group("knitting", () => {

      bench("nop", async () => {
        const arr = Array.from({ length: 10 }, () => callFunction.inLine());
        send();
        await Promise.all(arr);
        await fastCallFunction.inLine();
      });


        bench("1 thread (fast) → 1", async () => {
          await fastCallFunction.inLine();
        }).baseline(true);

        for (const n of sizes) {
          bench(`1 thread → ${n}`, async () => {
            const arr = Array.from({ length: n }, () => callFunction.inLine());
            send();
            await Promise.all(arr);
          });
        }
  
    });
  

  await mitataRun({ format , 
    //print: (jsonString) => console.log(JSON.stringify(JSON.parse(jsonString),null,2))
  });
  await terminateAllWorkers();
  await terminateAll();
}
