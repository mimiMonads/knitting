// nested-recursion-queue.bench.ts
// Run:
//   bun nested-recursion-queue.bench.ts
//   deno run -A nested-recursion-queue.bench.ts
//   npx tsx nested-recursion-queue.bench.ts
//
// Tweak:
//   DEPTH=50 BATCH=20 bun nested-recursion-queue.bench.ts
//
// Notes:
// - Each benchmark iteration creates a *chain* of DEPTH callbacks,
//   where each callback schedules the next (no breadth).
// - This starves the event loop until the chain finishes (especially nextTick/microtask).
// - DEPTH of 10–1000 is typical; huge values can lock the loop for a while.

import { bench, group, run } from "mitata";

// ── env helpers ───────────────────────────────────────────────────
function getenv(name: string, fallback: string): string {
  if (typeof process !== "undefined" && process.env && name in process.env) {
    return process.env[name] as string;
  }
  // @ts-ignore Deno
  if (typeof Deno !== "undefined" && Deno?.env?.get) {
    // @ts-ignore
    const v = Deno.env.get(name);
    if (v != null) return v;
  }
  // @ts-ignore Bun
  if (typeof Bun !== "undefined" && Bun?.env && name in Bun.env) {
    // @ts-ignore
    return Bun.env[name];
  }
  return fallback;
}

const DEPTH = Number(getenv("DEPTH", "5")); // callbacks in one chain
const BATCH = Number(getenv("BATCH", "5")); // chains per mitata iteration

const hasNextTick = typeof process !== "undefined" &&
  typeof process.nextTick === "function";
const hasSetImmediate = typeof setImmediate === "function";

// ── MessageChannel cross-runtime (global or worker_threads) ──────
type MessageChannelCtor = new () => { port1: any; port2: any };
async function getMessageChannelCtor(): Promise<MessageChannelCtor | null> {
  if (typeof (globalThis as any).MessageChannel === "function") {
    return (globalThis as any).MessageChannel;
  }
  try {
    // @ts-ignore
    const wt = await import("node:worker_threads");
    if (wt?.MessageChannel) return wt.MessageChannel as any;
  } catch {}
  return null;
}

// ── ChannelHandler (your pattern) ─────────────────────────────────
class ChannelHandler {
  public channel: any;
  private useOnEvent = false;

  constructor(MC: MessageChannelCtor) {
    this.channel = new MC();
    this.useOnEvent = typeof this.channel.port1.on === "function";
  }

  notify(): void {
    this.channel.port2.postMessage(null);
  }

  open(f: () => void): void {
    if (this.useOnEvent) {
      this.channel.port1.removeAllListeners?.("message");
      this.channel.port1.on("message", f);
    } else {
      this.channel.port1.onmessage = f;
      this.channel.port2.start?.();
      this.channel.port1.start?.();
    }
  }

  close(): void {
    if (this.useOnEvent) {
      this.channel.port1.removeAllListeners?.("message");
    } else {
      this.channel.port1.onmessage = null;
      this.channel.port2.onmessage = null;
    }
    this.channel.port1.close?.();
    this.channel.port2.close?.();
  }
}

const MC = await getMessageChannelCtor();
const hasChannel = !!MC;

// ── NESTED (CHAIN) BUILDERS ───────────────────────────────────────
// Each returns a Promise that resolves after DEPTH nested steps.
// Each step *schedules the next* rather than enqueuing a batch.

function nestedQueueMicrotask(depth: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let i = 0;
    function step() {
      if (++i >= depth) {
        resolve();
      } else {
        queueMicrotask(step);
      }
    }
    queueMicrotask(step);
  });
}

function nestedPromiseThen(depth: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let i = 0;
    function step() {
      if (++i >= depth) {
        resolve();
      } else {
        Promise.resolve().then(step);
      }
    }
    Promise.resolve().then(step);
  });
}

function nestedNextTick(depth: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let i = 0;
    function step() {
      if (++i >= depth) {
        resolve();
      } else {
        // @ts-ignore
        process.nextTick(step);
      }
    }
    // @ts-ignore
    process.nextTick(step);
  });
}

function nestedSetImmediate(depth: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let i = 0;
    function step() {
      if (++i >= depth) {
        resolve();
      } else {
        // @ts-ignore
        setImmediate(step);
      }
    }
    // @ts-ignore
    setImmediate(step);
  });
}

function nestedSetTimeout0(depth: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let i = 0;
    function step() {
      if (++i >= depth) {
        resolve();
      } else {
        setTimeout(step, 0);
      }
    }
    setTimeout(step, 0);
  });
}

function nestedChannel(depth: number, ch: ChannelHandler): Promise<void> {
  return new Promise<void>((resolve) => {
    let i = 0;
    function onMsg() {
      if (++i >= depth) {
        ch.open(() => {}); // detach to avoid leaks
        resolve();
      } else {
        ch.notify();
      }
    }
    ch.open(onMsg);
    ch.notify();
  });
}

// ── optional re-usable channel instance ───────────────────────────
const channel = hasChannel ? new ChannelHandler(MC!) : null;

// ── BENCHES ───────────────────────────────────────────────────────
group(`nested recursion chains (DEPTH=${DEPTH}, BATCH=${BATCH})`, () => {
  bench("queueMicrotask (nested)", async () => {
    for (let b = 0; b < BATCH; b++) await nestedQueueMicrotask(DEPTH);
  });

  bench("Promise.then (nested)", async () => {
    for (let b = 0; b < BATCH; b++) await nestedPromiseThen(DEPTH);
  });

  if (hasNextTick) {
    bench("process.nextTick (nested)", async () => {
      for (let b = 0; b < BATCH; b++) await nestedNextTick(DEPTH);
    });
  }

  if (channel) {
    bench("MessageChannel (nested)", async () => {
      for (let b = 0; b < BATCH; b++) await nestedChannel(DEPTH, channel);
    });
  }

  if (hasSetImmediate) {
    bench("setImmediate (nested)", async () => {
      for (let b = 0; b < BATCH; b++) await nestedSetImmediate(DEPTH);
    });
  }

  bench("setTimeout(0) (nested)", async () => {
    for (let b = 0; b < BATCH; b++) await nestedSetTimeout0(DEPTH);
  });
});

await run();
channel?.close?.();
