# knitting

Shared-memory worker pool for Node.js, Deno, and Bun. Define tasks once, then
call them from the main thread with a small, typed API.

## Requirements

- Node.js 22+
- Deno 2+
- Bun (recent)

## Install

This package is published on JSR:

```bash
deno add --npm jsr:@vixeny/knitting
```


## Quick Start

```ts
import { createPool, isMain, task } from "@vixeny/knitting";

export const hello = task({
  f: async () => "hello",
});

export const world = task({
  f: async () => "world",
});

const { call, shutdown } = createPool({
  threads: 2,
})({
  hello,
  world,
});

if (isMain) {
  const jobs = [
    call.hello(),
    call.world(),
    call.hello(),
    call.world(),
  ];


  const results = await Promise.all(jobs);
  console.log("Results:", results);
  shutdown();
}
```

## Batching Pattern

`call.*()` will enqueue work and usually wakes the dispatcher automatically.
Calling `send()` after creating a batch makes the intent explicit and can reduce
latency under load.

```ts
const jobs = Array.from({ length: 1_000 }, () => call.hello());
send();
const results = await Promise.all(jobs);
```

## API Overview

### `task({ f, href?, timeout? })`

Wraps a function (sync or async) so it can be registered and executed in
workers. `call.*()` always returns a promise. Inputs can also be promises,
they’ll be awaited before dispatch.

Guidelines:

- Define tasks at module scope.
- Export tasks you want workers to discover.
- Prefer a single argument. For multiple values, pass a tuple or object.

Example with arguments:

```ts
export const add = task<[number, number], number>({
  f: async ([a, b]) => a + b,
});
```

Single-task short mode:

```ts
export const world = task({
  f: async () => "world",
}).createPool({
  threads: 2,
});

if (isMain) {
  const results = await Promise.all([world.call()]);
  console.log("Results:", results);
  world.shutdown();
}
```

### `createPool(options)(tasks)`

Creates a worker pool and returns:

- `call.<task>(args)` enqueue a task call.
- `shutdown()` terminates workers.

Key options:

- `threads?: number` number of worker threads (default `1`).
- `inliner?: { position?: "first" | "last"; batchSize?: number }` run tasks on the main thread as
  an extra lane.
- `balancer?: "robinRound" | "firstIdle" | "randomLane" | "firstIdleOrRandom"`
  or `{ strategy: "robinRound" | "firstIdle" | "randomLane" | "firstIdleOrRandom" }`
  task routing strategy.
- `worker?: { resolveAfterFinishingAll?: true; timers?: WorkerTimers }`
- `host?: DispatcherSettings`
- `debug?: { extras?: boolean; logMain?: boolean; logHref?: boolean;
  logImportedUrl?: boolean }`
- `source?: string` override the worker entry module.

Example with an inline executor lane:

```ts
const pool = createPool({
  threads: 3,
  inliner: { position: "last", batchSize: 1 },
})({ add });
```

#### Runtime tuning options

You can tune idle behavior and backoff:

- `worker.timers.spinMicroseconds?: number` busy‑spin budget before parking (µs).
- `worker.timers.parkMs?: number` `Atomics.wait` timeout when parked (ms).
- `worker.timers.pauseNanoseconds?: number` `Atomics.pause` duration while spinning (ns).
- `host.stallFreeLoops?: number` notify loops before backoff starts.
- `host.maxBackoffMs?: number` max backoff delay (ms).

Example:

```ts
const pool = createPool({
  threads: 2,
  worker: {
    timers: { 
      spinMicroseconds: 40, 
      parkMs: 10, 
      pauseNanoseconds: 200 
      },
  },
  host: {
    stallFreeLoops: 64,
    maxBackoffMs: 5,
  },
})({ add });
```

### `isMain`

Boolean flag to guard main-thread-only code.

## Supported Payloads

The transport supports common structured data:

- `number` including `NaN`, `Infinity`, and `-Infinity`
- `string`
- `boolean`
- `bigint`
- `undefined` and `null`
- `Object` and `Array`
- `Map` and `Set`
- `Promise<supported>` (resolved on the host before dispatch; rejections
  propagate to the caller)

If you need to pass several values, prefer a single object or tuple:

```ts
export const search = task<
  { start: number; end: number },
  number[]
>({
  f: async ({ start, end }) => {
    // ...
    return [];
  },
});
```

## Balancing Strategies

You can control how calls are routed:

- `"robinRound"` default round-robin
- `"firstIdle"` prefer idle workers
- `"randomLane"` choose a random worker
- `"firstIdleOrRandom"` idle first, then random

You can also pass `{ strategy: "..." }` if you prefer an object form.

## Best Practices

- Export tasks from the module where they are defined.
- Keep task definitions at top level (avoid conditional exports).
- Batch many calls, then use `send()` once.
- Use a tuple or object when you need multiple arguments.

## Benchmarks

There are several benchmarks under `bench/`. To run the top-level ones across
Node, Deno, and Bun:

```bash
./run.sh
```

Results are written into `results/`.

To emit JSON (useful for plotting scripts under `graphs/`):

```bash
./run.sh --json
```

## Development

Common local commands:

```bash
deno test
./run.sh
bun run build.ts
```

## License

CC-BY-ND-4.0
