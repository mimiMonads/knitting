// CPU-cost harness: fixed work, measure wall time AND whole-process CPU
// (process.cpuUsage covers worker threads too). Reports µs of CPU per call,
// which is the number we actually want to push down.
import { createPool, isMain, task } from "../../knitting.ts";

export const add = task<number, number>({ f: (v) => v + 1 });

const THREADS = Number(process.env.KB_THREADS ?? 2);
const CALLS = Number(process.env.KB_CALLS ?? 200_000);
const INFLIGHT = Number(process.env.KB_INFLIGHT ?? 512);
const REPS = Number(process.env.KB_REPS ?? 5);

if (isMain) {
  const { call, shutdown } = createPool({
    threads: THREADS,
    worker: {
      timers: {
        spinMicroseconds: Number(process.env.KB_SPIN ?? 10),
        parkMs: Number(process.env.KB_PARK ?? 5),
      },
    },
  })({ add });

  // Bounded-inflight driver: keeps the pipe full without allocating CALLS
  // promises up front (which would measure the allocator, not the loop).
  const drive = async (n: number) => {
    let issued = 0, done = 0;
    await new Promise<void>((resolveAll, reject) => {
      const pump = () => {
        while (issued < n && issued - done < INFLIGHT) {
          issued++;
          call.add(1).then(() => {
            done++;
            if (done === n) resolveAll();
            else pump();
          }, reject);
        }
      };
      pump();
    });
  };

  await drive(20_000); // warm up JIT + park/spin state

  const rows: { wall: number; cpu: number; sys: number }[] = [];
  for (let r = 0; r < REPS; r++) {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    await drive(CALLS);
    const wall = performance.now() - t0;
    const c1 = process.cpuUsage(c0);
    rows.push({
      wall,
      cpu: (c1.user + c1.system) / 1000,
      sys: c1.system / 1000,
    });
  }

  const med = (xs: number[]) =>
    xs.slice().sort((a, b) => a - b)[xs.length >> 1]!;
  const wall = med(rows.map((r) => r.wall));
  const cpu = med(rows.map((r) => r.cpu));
  const sys = med(rows.map((r) => r.sys));
  console.log(JSON.stringify({
    label: process.env.KB_LABEL ?? "run",
    threads: THREADS,
    calls: CALLS,
    wall_ms: +wall.toFixed(1),
    cpu_ms: +cpu.toFixed(1),
    sys_ms: +sys.toFixed(1),
    rps: Math.round(CALLS / (wall / 1000)),
    cpu_us_per_call: +((cpu * 1000) / CALLS).toFixed(3),
    cpu_over_wall: +(cpu / wall).toFixed(2),
  }));
  await shutdown();
}
