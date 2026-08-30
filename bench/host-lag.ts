/**
 * Host event-loop fairness probe.
 *
 * Saturates the pool from the host while a timer and a loopback TCP socket
 * measure how long the host loop takes to get scheduled. This is the in-repo
 * analogue of the Hono bed's pool-free `/ping` route: throughput benches drive
 * the pool from a tight await loop with nothing else on the loop, so they
 * cannot see host-loop starvation at all.
 */
import { createServer, Socket } from "node:net";
import { createPool, isMain, task } from "../knitting.ts";

const BASE = Math.max(1, Number(process.env.HL_BASE ?? "12000"));

export const mixed = task<number, number>({
  f: (input) => {
    const shape = input & 3;
    const rounds = BASE *
      (shape === 0 ? 1 : shape === 1 ? 2 : shape === 2 ? 4 : 8);
    let value = (input ^ 0x9e3779b9) >>> 0;
    for (let index = 0; index < rounds; index++) {
      value = (value * 1664525 + 1013904223) >>> 0;
    }
    return value;
  },
});

const THREADS = Math.max(1, Number(process.env.HL_THREADS ?? "1"));
const INFLIGHT = Math.max(1, Number(process.env.HL_INFLIGHT ?? "64"));
const DURATION_MS = Math.max(500, Number(process.env.HL_DURATION_MS ?? "6000"));
const WARMUP_MS = Math.max(0, Number(process.env.HL_WARMUP_MS ?? "1500"));
const PROBE_MS = Math.max(1, Number(process.env.HL_PROBE_MS ?? "5"));
const TOPOLOGY = process.env.HL_TOPOLOGY ?? "per-thread";
const DOORBELL = process.env.HL_DOORBELL === "0"
  ? false
  : process.env.HL_DOORBELL === "1"
  ? true
  : undefined;
const STALL_FREE = process.env.HL_STALL_FREE === undefined
  ? undefined
  : Number(process.env.HL_STALL_FREE);

const host: Record<string, unknown> = {};
if (DOORBELL !== undefined) host.doorbell = DOORBELL;
if (STALL_FREE !== undefined) host.stallFreeLoops = STALL_FREE;
if (TOPOLOGY === "steal") host.steal = true;
else {
  host.steal = false;
  host.dispatcher = TOPOLOGY;
}

const pool = createPool({
  threads: THREADS,
  host: host as never,
})({ mixed });

const quantile = (sorted: number[], q: number) => {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[at]!;
};

const summarise = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: quantile(sorted, 0.5),
    p99: quantile(sorted, 0.99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
  };
};

if (isMain) {
  // Loopback socket pair: exercises the poll phase, not just the timer phase.
  const server = createServer((socket) => {
    socket.setNoDelay(true);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const client: Socket = await new Promise((resolve) => {
    const s = new Socket();
    s.setNoDelay(true);
    s.connect(port, "127.0.0.1", () => resolve(s));
  });

  const timerLag: number[] = [];
  const socketRtt: number[] = [];
  let recording = false;

  let sentAt = 0;
  let socketPending = false;
  client.on("data", () => {
    const elapsed = performance.now() - sentAt;
    socketPending = false;
    if (recording) socketRtt.push(elapsed);
  });

  let stop = false;
  const probeTimer = () => {
    if (stop) return;
    const expected = performance.now() + PROBE_MS;
    setTimeout(() => {
      if (recording) timerLag.push(performance.now() - expected);
      if (!socketPending) {
        socketPending = true;
        sentAt = performance.now();
        client.write("p");
      }
      probeTimer();
    }, PROBE_MS);
  };
  probeTimer();

  let issued = 0;
  let completed = 0;
  let state = 0x12345678;
  const nextInput = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return (value ^ (value >>> 14)) >>> 0;
  };

  let sink = 0;
  let done: (() => void) | undefined;
  let draining = false;

  const pump = () => {
    while (!draining && issued - completed < INFLIGHT) {
      issued++;
      pool.call.mixed(nextInput()).then((value) => {
        completed++;
        sink ^= value;
        if (draining) {
          if (issued === completed) done?.();
          return;
        }
        pump();
      });
    }
  };

  const startedAt = performance.now();
  pump();
  await new Promise((resolve) => setTimeout(resolve, WARMUP_MS));
  const warmCompleted = completed;
  const warmAt = performance.now();
  recording = true;
  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  recording = false;
  const measuredCompleted = completed - warmCompleted;
  const measuredMs = performance.now() - warmAt;
  draining = true;
  await new Promise<void>((resolve) => {
    done = resolve;
    if (issued === completed) resolve();
  });
  stop = true;
  client.destroy();
  server.close();

  const cpu = process.cpuUsage();
  console.log(JSON.stringify({
    label: process.env.HL_LABEL ?? "",
    threads: THREADS,
    topology: TOPOLOGY,
    base: BASE,
    inflight: INFLIGHT,
    doorbell: DOORBELL ?? null,
    stall_free: STALL_FREE ?? null,
    ops_per_second: (measuredCompleted / measuredMs) * 1000,
    completed: measuredCompleted,
    wall_ms: performance.now() - startedAt,
    host_cpu_ms: (cpu.user + cpu.system) / 1000,
    timer_lag_ms: summarise(timerLag),
    socket_rtt_ms: summarise(socketRtt),
    sink,
  }));

  await pool.shutdown();
}
