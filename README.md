# knitting
[![Tests](https://github.com/mimiMonads/knitting/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/mimiMonads/knitting/actions/workflows/test.yml)
[![Coverage Workflow](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml/badge.svg?branch=main)](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml)
[![Coverage (node lines)](https://img.shields.io/badge/coverage%20(node%20lines)-92.10%25-brightgreen)](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Deno >=2](https://img.shields.io/badge/deno-%3E%3D2-111111?logo=deno&logoColor=white)](https://deno.com/)
[![Bun recent](https://img.shields.io/badge/bun-recent-f5f5dc?logo=bun&logoColor=black)](https://bun.sh/)

Shared-memory worker pool for Node.js, Deno, and Bun. Define tasks once, then
call them from the main thread with a small, typed API.

## Requirements

- Node.js 22+
- Deno 2+
- Bun (recent)

## Install

This package is published on JSR:

```bash
deno add jsr:@vixeny/knitting
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

### `task({ f, href?, timeout?, abortSignal? })`

Wraps a function (sync or async) so it can be registered and executed in
workers. `call.*()` always returns a promise. Inputs can also be native
promises, they’ll be awaited before dispatch.
Only native `Promise` values are awaited; thenables are treated as regular
values.

`abortSignal` enables abort-aware metadata for that task.
Accepted values:

- `true`
- `{ hasAborted: true }`

Usage:

```ts
import { createPool, task } from "@vixeny/knitting";

export const slowTask = task({
  abortSignal: true,
  f: async (value: string) => {
    // Your worker code
    return value.toUpperCase();
  },
});

const { call, shutdown } = createPool({ threads: 1 })({
  slowTask,
});

const pending = call.slowTask("hello");
// today there is no public per-call cancel API yet
// shutdown() rejects pending calls with "Thread closed"
await shutdown();
await pending.catch(() => {});
```

Current behavior:

- Host allocates a signal id and encodes it into task metadata.
- Worker checks signal state before invoking the task function.
- If already aborted, the call rejects with `Error("Task aborted")`.
- Signal cleanup is guarded to run once on settle (resolve or reject).
- Abort-aware pool capacity defaults to `258` signals (when at least one task
  uses `abortSignal`) and can be tuned with `createPool({ abortSignalCapacity })`.

Current limitation:

- There is no public per-call cancel API yet; `shutdown()` still rejects
  pending calls with `"Thread closed"`.

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
- `balancer?: "roundRobin" | "robinRound" | "firstIdle" | "randomLane" | "firstIdleOrRandom"`
  or `{ strategy?: "roundRobin" | "robinRound" | "firstIdle" | "randomLane" | "firstIdleOrRandom" }`
  task routing strategy.
- `worker?: { resolveAfterFinishingAll?: true; timers?: WorkerTimers }`
- `payloadInitialBytes?: number` initial payload SAB size per worker direction (bytes).
- `payloadMaxBytes?: number` max payload SAB size per worker direction (bytes).
- `abortSignalCapacity?: number` max abort-aware in-flight signals (default `258`).
  This applies only when at least one task declares `abortSignal`.
- `host?: DispatcherSettings`
- `workerExecArgv?: string[]` extra worker `execArgv` flags.
- `permission?: "strict" | "unsafe" | PermisonProtocol`
  (and `permison` alias) for runtime access policy:
  - `"strict"` (default when passing an object): hardened mode with deny lists.
  - `"unsafe"`: disables permission hardening (no fs deny guards, console enabled,
    strips Node permission flags inherited from parent/worker options).
  - disable permission protocol entirely by omitting `permission`.
  Strict defaults include read/write rooted at current `cwd`, deny-write for
  `node_modules`, deny read/write for sensitive paths (`.env`, `.git`,
  `.npmrc`, `.docker`, `.secrets`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`,
  `~/.config/gcloud`, `~/.kube`, plus POSIX system paths `/proc`,
  `/proc/self`, `/proc/self/environ`, `/proc/self/mem`, `/sys`, `/dev`, `/etc`),
  block process execution APIs (`node:child_process`, `Deno.Command`, `Deno.run`,
  `Bun.spawn*`) unless explicitly enabled,
  block worker-spawn APIs (`node:worker_threads.Worker`, global `Worker`) in strict mode,
  block Node internals that can spawn (`process.binding`, `process._linkedBinding`,
  `process.dlopen`) in strict mode,
  read support for `deno.lock` and `bun.lock*`,
  and Node `--permission` worker flags (Node runtime).
  `console?: boolean` can be set in object mode (`false` by default in strict,
  `true` by default in unsafe).
  Process execution overrides:
  `node.allowChildProcess?: boolean`, `deno.allowRun?: boolean`,
  `bun.allowRun?: boolean` (all default to `false` in strict mode).
  Bun caveat: `bun:ffi` is a native interface and can bypass in-process JS guards.
  Bun strict mode runs a preflight source scan and rejects task modules that
  reference `bun:ffi`, `node:worker_threads`, `node:fs`, `node:module`,
  `process.binding`, `process._linkedBinding`, `process.dlopen`,
  `Bun.dlopen`/`Bun.linkSymbols`, dynamic `import(...)`, `require(...)`,
  `createRequire(...)`, or `eval`/`Function` constructors.
  Do not treat Bun strict mode as a full sandbox for untrusted code; use an
  OS/container boundary for hard isolation.
- `dispatcher?: DispatcherSettings` deprecated alias of `host`.
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

Permission examples:

```ts
// Hardened defaults
createPool({ permission: {} })({ add });

// Shorthand full-access mode
createPool({ permission: "unsafe" })({ add });

// Explicit strict mode + console enabled
createPool({ permission: { mode: "strict", console: true } })({ add });
```

Timing note:

- Worker timing paths capture a high-resolution `performance.now()` reference at
  module load/startup time. This keeps scheduling/timeout precision stable without
  freezing global `performance`.

#### Safety hardening defaults

- Startup-only guard layer: safety hooks are installed once before the worker
  loop starts (no extra checks inside the hot task-processing loop).
- Process termination APIs from task code are blocked (`process.exit`,
  `process.kill`, `process.abort`, plus `Deno.exit`/`Bun.exit` when present).
- Worker timing uses captured high-resolution clock references to avoid
  precision regressions from later task-level monkey-patching.
- In strict permission mode, Node FS/Deno/Bun file APIs are wrapped with deny
  checks for sensitive paths. Node workers also receive permission CLI flags in
  strict mode.

#### Runtime tuning options

You can tune idle behavior and backoff:

- `worker.timers.spinMicroseconds?: number` busy‑spin budget before parking (µs).
- `worker.timers.parkMs?: number` `Atomics.wait` timeout when parked (ms).
- `worker.timers.pauseNanoseconds?: number` `Atomics.pause` duration while spinning (ns). Set to
  `0` to disable pause calls.
- `payloadInitialBytes?: number` initial payload buffer size in bytes.
- `payloadMaxBytes?: number` max payload buffer size in bytes.
- `abortSignalCapacity?: number` max concurrent abort-aware in-flight calls
  (default `258`).
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

The transport supports these payloads:

- `number` including `NaN`, `Infinity`, and `-Infinity`
- `string`
- `boolean`
- `bigint`
- `undefined` and `null`
- plain JSON-like `Object` and `Array`
- `Buffer` (Node.js), `ArrayBuffer`, `Uint8Array`, `Int32Array`, `Float64Array`, `BigInt64Array`,
  `BigUint64Array`, and `DataView`
- global `symbol` values (`Symbol.for(...)`)
- `Error` and `Date`
- native `Promise<supported>` (resolved on the host before dispatch; rejections
  propagate to the caller)

Thenables are not awaited by the transport.

Not supported directly:

- `Map`, `Set`, `WeakMap`, custom class instances
- non-global symbols
- `Blob`
- functions

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

- `"roundRobin"` default round-robin
- `"robinRound"` legacy alias of `"roundRobin"`
- `"firstIdle"` prefer idle workers
- `"randomLane"` choose a random worker
- `"firstIdleOrRandom"` idle first, then random

You can also pass `{}` or `{ strategy: "..." }` if you prefer an object form.
When omitted, strategy defaults to `"roundRobin"`.

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
deno test -A --ignore=test/runtime.node.test.ts
node --no-warnings --experimental-transform-types --test "./test/*.test.ts"
./run.sh
bun run build.ts
```

## License

Apache 2.0
