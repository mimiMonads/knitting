/**
 * SO_REUSEPORT variant of `server.ts`: identical bed and routes, but the
 * listener sets `reusePort`, so several copies of this process can bind the
 * same port and the kernel spreads accepts across them. Launch N copies to
 * scale the host side past one JS thread.
 *
 * Simulated HTTP server for A/B-ing the dispatcher against real request
 * traffic. Driven externally with `oha`, so the load generator is a separate
 * process and the numbers are end-to-end request latency, not pool latency.
 *
 * Three routes, each a different scheduling shape:
 *   /echo   trivial task — pure coordination overhead, nothing to balance
 *   /work   randomised cost from a seeded table — the imbalance stealing is for
 *   /mixed  four different task functions round-robined — heterogeneous fanout
 *
 * Env: SRV_MODE=plain|steal|per-thread  SRV_THREADS  SRV_PORT  SRV_BASE
 */
import { createPool, isMain, task } from "../../knitting.ts";

export const echo = task<string, string>({
  f: (s) => s,
});

export const spin = task<number, number>({
  f: (rounds) => {
    let x = 1;
    for (let i = 0; i < rounds; i++) x = (x * 1664525 + 1013904223) >>> 0;
    return x >>> 24;
  },
});

export const hashStr = task<string, number>({
  f: (s) => {
    let h = 2166136261;
    for (let r = 0; r < 40; r++) {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    return h >>> 0;
  },
});

export const sortNums = task<number, number>({
  f: (n) => {
    const a = new Array(n);
    let s = n | 1;
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      a[i] = s >>> 16;
    }
    a.sort((x, y) => x - y);
    return a[n >> 1]!;
  },
});

export const fibo = task<number, number>({
  f: (n) => {
    const go = (k: number): number => (k < 2 ? k : go(k - 1) + go(k - 2));
    return go(n);
  },
});

export const jsonShape = task<string, number>({
  f: (s) => {
    let total = 0;
    for (let r = 0; r < 30; r++) {
      const obj = JSON.parse(s) as {
        items: Array<{ id: number; tag: string }>;
      };
      const mapped = obj.items.map((it) => ({
        ...it,
        tag: it.tag.toUpperCase(),
      }));
      total += JSON.parse(JSON.stringify(mapped)).length;
    }
    return total;
  },
});

if (isMain) {
  const MODE = process.env.SRV_MODE ?? "plain";
  const THREADS = Number(process.env.SRV_THREADS ?? "4");
  const PORT = Number(process.env.SRV_PORT ?? "8787");
  const BASE = Number(process.env.SRV_BASE ?? "40000");

  const options = MODE === "steal"
    ? { threads: THREADS, host: { steal: true } }
    : MODE === "per-thread"
    ? {
      threads: THREADS,
      host: { dispatcher: "per-thread" as const, steal: false },
    }
    : { threads: THREADS, host: { steal: false } };

  const { call, shutdown } = createPool(options as never)({
    echo,
    spin,
    hashStr,
    sortNums,
    fibo,
    jsonShape,
  });

  // Seeded cost table: both variants see the same multiset of task sizes in the
  // same cyclic order, so the comparison is scheduling and not the workload.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const next = rng(987654);
  const COSTS = new Array(4096);
  for (let i = 0; i < 4096; i++) {
    const r = next();
    // 90% around BASE, 10% an order of magnitude heavier: the tail is what a
    // static partition mis-assigns.
    COSTS[i] = r < 0.1
      ? Math.floor(BASE * (8 + r * 40))
      : Math.max(1, Math.floor(BASE * (0.3 + r * 1.4)));
  }

  const PAYLOAD = JSON.stringify({
    items: Array.from({ length: 24 }, (_, i) => ({ id: i, tag: `tag-${i}` })),
  });

  let n = 0;

  // Warm every function so first-call bootstrap is outside the measurement.
  await Promise.all([
    call.echo("warm"),
    call.spin(BASE),
    call.hashStr("warm"),
    call.sortNums(512),
    call.fibo(18),
    call.jsonShape(PAYLOAD),
  ]);

  const mixed = async (i: number) => {
    switch (i & 3) {
      case 0:
        return await call.hashStr(PAYLOAD);
      case 1:
        return await call.sortNums(2000 + (i & 1023));
      case 2:
        return await call.fibo(20 + (i & 3));
      default:
        return await call.jsonShape(PAYLOAD);
    }
  };

  const handle = async (path: string): Promise<Response> => {
    const i = n++;
    if (path === "/echo") {
      return new Response(await call.echo("pong"));
    }
    if (path === "/work") {
      return new Response(String(await call.spin(COSTS[i & 4095]!)));
    }
    if (path === "/mixed") {
      return new Response(String(await mixed(i)));
    }
    if (path === "/ready") return new Response("ok");
    return new Response("not found", { status: 404 });
  };

  // Bun-only harness; typed locally so `deno check` stays clean.
  const bunServe = (globalThis as unknown as {
    Bun?: {
      serve: (
        options: {
          port: number;
          reusePort?: boolean;
          fetch: (req: Request) => Promise<Response>;
        },
      ) => { stop: (closeActive?: boolean) => void };
    };
  }).Bun?.serve;

  if (bunServe === undefined) {
    throw new Error("bench/steal/server.ts needs Bun");
  }

  const server = bunServe({
    port: PORT,
    // SO_REUSEPORT: the kernel load-balances accepts across every process bound
    // here, so N hosts each run their own pool and the single-JS-thread accept
    // ceiling stops being the limit.
    reusePort: true,
    // Keep the accept path out of the way of the pool; the pool is the subject.
    fetch: (req: Request) => handle(new URL(req.url).pathname),
  });

  const stop = () => {
    server.stop(true);
    shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(`ready ${MODE} threads=${THREADS} port=${PORT}`);
}
