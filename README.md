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
  await shutdown();
}
```

## Batching Pattern

`call.*()` enqueues work and dispatches automatically.
For batches, create all calls first and then await them together.

```ts
const jobs = Array.from({ length: 1_000 }, () => call.hello());
const results = await Promise.all(jobs);
```

## API Overview

### `task({ f, href?, timeout? })`

Wraps a function (sync or async) so it can be registered and executed in
workers. `call.*()` always returns a promise. Inputs can also be promises,
they’ll be awaited before dispatch.

#### `href` override behavior (unsafe / experimental)

`task()` normally captures the caller module URL and uses that for worker-side
task discovery. Passing `href` overrides that module URL and forces workers to
import from your custom path/URL.

This is not considered safe as a public long-term contract and may be removed
in a future major release.

Rules for `href`:

- Prefer not using `href`; default caller resolution is the supported path.
- If you use it, pass an absolute module URL (`file://...` or full URL).
- Avoid remote URLs (`http(s)://...`) in production; runtime support and
  security expectations vary across Node/Deno/Bun.
- Ensure the target module exports top-level `task(...)` values discoverable by
  workers.
- Ensure `href` points to a stable module identity (do not use ad-hoc dynamic
  URL variations for the same task module).
- Treat this as compatibility-risky and pin versions if you depend on it.

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
  await world.shutdown();
}
```

### `createPool(options)(tasks)`

Creates a worker pool and returns:

- `call.<task>(args)` enqueue a task call.
- `shutdown(): Promise<void>` terminates workers.

Key options:

- `threads?: number` number of worker threads (default `1`).
- `inliner?: { position?: "first" | "last"; batchSize?: number; dispatchThreshold?: number }`
  run tasks on the main thread as an extra lane.
- `balancer?: "robinRound" | "firstIdle" | "randomLane" | "firstIdleOrRandom"`
  or `{ strategy?: "robinRound" | "firstIdle" | "randomLane" | "firstIdleOrRandom" }`
  task routing strategy.
- `worker?: { resolveAfterFinishingAll?: true; timers?: WorkerTimers }`
- `payloadInitialBytes?: number` initial payload SAB size per worker direction (bytes).
- `payloadMaxBytes?: number` max payload SAB size per worker direction (bytes).
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
- `worker.timers.pauseNanoseconds?: number` `Atomics.pause` duration while spinning (ns). Set to
  `0` to disable pause calls.
- `payloadInitialBytes?: number` initial payload buffer size in bytes.
- `payloadMaxBytes?: number` max payload buffer size in bytes.
- `host.stallFreeLoops?: number` notify loops before backoff starts.
- `host.maxBackoffMs?: number` max backoff delay (ms).
- `inliner.dispatchThreshold?: number` minimum in-flight calls before routing can use the
  inline host lane. Defaults to `1`.

Example:

```ts
const pool = createPool({
  threads: 2,
  inliner: {
    position: "last",
    batchSize: 1,
    dispatchThreshold: 16, // keep host free at low load; join only on bigger bursts
  },
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
- `Buffer` (Node.js), `ArrayBuffer`, `Uint8Array`, `Int32Array`, `Float64Array`, `BigInt64Array`,
  `BigUint64Array`, and `DataView`
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

You can also pass `{}` or `{ strategy: "..." }` if you prefer an object form.
When omitted, strategy defaults to `"robinRound"`.

## Best Practices

- Export tasks from the module where they are defined.
- Keep task definitions at top level (avoid conditional exports).
- Batch many calls, then await with `Promise.all`.
- Use a tuple or object when you need multiple arguments.
- Avoid `href` override unless strictly necessary (experimental/unsafe).

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
