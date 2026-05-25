# knitting

[![JSR Version](https://jsr.io/badges/@vixeny/knitting)](https://jsr.io/@vixeny/knitting)
[![JSR Score](https://jsr.io/badges/@vixeny/knitting/score)](https://jsr.io/@vixeny/knitting)
[![Tests](https://github.com/mimiMonads/knitting/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/mimiMonads/knitting/actions/workflows/test.yml)
[![Coverage Workflow](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml/badge.svg?branch=main)](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml)
[![Coverage](https://img.shields.io/badge/coverage-92.10%25-brightgreen)](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Node](https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Deno](https://img.shields.io/badge/deno-2%2B-000000?logo=deno&logoColor=white)](https://deno.com/)
[![Bun](https://img.shields.io/badge/bun-1%2B-f472b6?logo=bun&logoColor=white)](https://bun.sh/)

Knitting is a worker-pool over shared-memory IPC runtime for Node.js,
Deno, and Bun. Which mission is make javascript a real multicore language,
Thanks to its memory design, it can be from 5x to 25x faster than using `postMessages`
bypassing OS sockect comunnication entielly with a novel protocol written from scratch.

Use it for the parts of your program that should run somewhere else: CPU-heavy to small
work, runtime-isolated jobs, long-running tools, or anything that needs to move
speed and type felixbility.


You define a task once, spin up a pool, and call it like a normal async
function:

```ts
const result = await pool.call.resizeImage(file);
```

Under the hood, Knitting schedules work across worker threads or separate
processes (depending on runtime and your settings), keeps arguments typed, and
uses shared memory for transport.

## So

- Call worker code like `pool.call.myTask(arg)`.
- Keep the resolved types end-to-end
- Choose `threads` for speed or `processes` for stronger isolation.
- Move supported payloads via shared memory (great for binary data).
- Run on Node.js, Deno, or Bun.

## Why use it?

- Easy to use: Have a multi-thread enviroment or process with few lines of code.
- Great type support: pass primitives, JSON, Promise of these and special types (typed arrays, Node
  `Buffer`, `Envelope`, and `ProcessSharedBuffer`).
- Runtime flexibility: the same API across Node.js, Deno, and Bun.
- Worker choices: use threads for fast pools, or processes for stronger
  isolation.
- All out-of-the-box expierince: strict-by-default permissions, payload-size limits, task
  timeouts, abort-aware tasks, and worker hard timeouts.

## Requirements

- Node.js 22+ 
- Deno 2+ 
- Bun 1+ 

Process workers and `ProcessSharedBuffer` use the native shared-memory layer.
On Linux and macOS, build it before running process/shared-memory tests.
If you're only using thread workers, you can typically ignore this and use
Knitting without building native addons.

## Install

```bash
npm install @vixeny/knitting
```

Via JSR's npm compatibility:

```bash
jsr add --npm @vixeny/knitting
```

For Deno projects:

```bash
deno add jsr:@vixeny/knitting
```

## Quick Start

```ts
import { createPool, isMain, task } from "@vixeny/knitting";

export const square = task<number, number>({
  f: (value) => value * value,
});

export const greet = task<string, string>({
  f: (name) => `hello ${name}`,
});

if (isMain) {
  const pool = createPool({ threads: 2 })({ square, greet });

  try {
    const [four, message] = await Promise.all([
      pool.call.square(2),
      pool.call.greet("knitting"),
    ]);

    console.log({ four, message });
  } finally {
    await pool.shutdown();
  }
}
```

The `isMain` guard when the same module is loaded by workers or process. Export
exposes the tasks or functions at module scope, so knitting maps down the imports,
then use and use the pool only from the main program.

## The Mental Model

There are three core pieces, plus `isMain` for modules that workers may import:

```ts
import { createPool, isMain, task } from "@vixeny/knitting";
```

- `task(...)` describes a callable worker function (types + implementation).

- `createPool(options)({ tasks })` starts workers and gives you a typed `call`
object for invoking tasks.

- `pool.shutdown()` stops workers when you're done.

```ts
export const add = task<[number, number], number>({
  f: ([a, b]) => a + b,
});

if (isMain) {
  const pool = createPool({ threads: 4 })({ add });

  try {
    const value = await pool.call.add([1, 2]);
    console.log(value);
  } finally {
    await pool.shutdown();
  }
}
```

Once you have a pool, calls are just promises, so batching looks like normal
JavaScript:

```ts
const values = await Promise.all(
  Array.from({ length: 1_000 }, (_, index) => pool.call.add([index, 1])),
);
```

## Defining Tasks

### Arguments and return values

Each task receives one argument and returns one value. If you need multiple
inputs, pass an object or tuple.

```ts
type ResizeInput = {
  width: number;
  height: number;
};

export const pixels = task<ResizeInput, number>({
  f: ({ width, height }) => width * height,
});
```

Supported payloads are listed below. For large binary data, prefer
`ArrayBuffer`, typed arrays, or `ProcessSharedBuffer` instead of serializing
big objects.

### Task timeouts

Use a task timeout when a worker call should not wait forever.

```ts
export const maybeSlow = task<string, string>({
  timeout: { time: 500, default: "timed out" },
  f: async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return value.toUpperCase();
  },
});
```

Timeouts can reject the call, resolve with a default value, or use a custom
error depending on the timeout options you choose.

### Abort-aware tasks

If a task is long-running, opt into an abort signal and check it inside the
worker function.

```ts
export const countUntilStopped = task({
  abortSignal: { hasAborted: true },
  f: async (limit: number, signal) => {
    for (let index = 0; index < limit; index += 1) {
      if (signal.hasAborted()) return index;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    return limit;
  },
});
```

The pool also has an `abortSignalCapacity` option for sizing the shared abort
signal storage when many abort-aware calls may be in flight.

### Importing worker-side functions

`importTask` lets the worker import a normal function from another module. The
host gets a typed task wrapper, but it does not import or evaluate that worker
module itself.

That matters for process workers and sandboxing: if the code is supposed to run
inside the worker's permissions, keep it in a separate file and point
`importTask()` at that file.

```ts
// worker-tasks.ts
export const add = ([left, right]: [number, number]) => left + right;
```

```ts
// main.ts
import { createPool, importTask, isMain } from "@vixeny/knitting";

export const add = importTask<[number, number], number>({
  href: "./worker-tasks.ts",
  name: "add",
});

if (isMain) {
  const pool = createPool({ threads: 2 })({ add });

  try {
    console.log(await pool.call.add([2, 3]));
  } finally {
    await pool.shutdown();
  }
}
```

`href` can be a local relative path like `"./worker-tasks.ts"`, an absolute file
path, or a URL. Relative paths are resolved from the module that calls
`importTask()`.

When workers import files, keep the pool's permission settings in mind. The
default strict mode allows task imports, but custom permission policies can
limit reads, writes, environment access, networking, and process execution.

### Single-task shorthand

For quick scripts, a task can create its own pool:

```ts
import { isMain, task } from "@vixeny/knitting";

export const double = task<number, number>({
  f: (value) => value * 2,
}).createPool({ threads: 2 });

if (isMain) {
  try {
    console.log(await double.call(21));
  } finally {
    await double.shutdown();
  }
}
```

## Creating Pools

You typically create one pool per set of tasks and reuse it.

```ts
const pool = createPool({
  threads: 4,
  balancer: "firstIdle",
  payload: {
    payloadMaxByteLength: 64 * 1024 * 1024,
    maxPayloadBytes: 8 * 1024 * 1024,
  },
})({ add, pixels });
```

Common options you might tweak:

| Option | What it does |
| --- | --- |
| `threads` | Number of workers to start. |
| `balancer` | Scheduling strategy: `"roundRobin"`, `"firstIdle"`, `"randomLane"`, `"firstIdleOrRandom"`, or the legacy alias `"robinRound"`. |
| `payload` | Shared payload-buffer settings: `mode`, `payloadInitialBytes`, `payloadMaxByteLength`, and `maxPayloadBytes`. |
| `abortSignalCapacity` | Number of shared abort slots available to abort-aware calls. |
| `worker.resolveAfterFinishingAll` | Let submitted calls finish before shutdown resolves. |
| `worker.hardTimeoutMs` | Force pool shutdown when a task exceeds this many milliseconds. |
| `worker.runtime` | Choose `"thread"` or `"process"` workers. |
| `permission` | Runtime permission policy for workers. |
| `debug` | Enable extra diagnostics. |
| `source` | Worker source override for advanced runtimes. |

## Worker Runtimes

By default, workers use runtime-local threads where possible (the lowest
overhead option).

```ts
const pool = createPool({
  threads: 4,
})({ add });
```

If you want stronger isolation, or you need to run workers through a specific
runtime executable, use process workers.

```ts
const pool = createPool({
  threads: 2,
  worker: {
    runtime: "process",
    processRuntime: "node",
  },
})({ add });
```

`processRuntime` can be `"node"`, `"deno"`, or `"bun"`. You can also provide a
`processCommandPrefix` when workers need to be launched through a wrapper such
as a package manager, container command, or runtime shim.

That prefix is also useful for sandbox and resource-control tools. The one
important detail is that process workers receive their shared-memory handle on
stdin, which is file descriptor 0. Wrappers that leave stdin alone usually work;
wrappers that replace, close, or proxy stdin without passing the fd through will
stop the worker from booting.

When the goal is isolation, define the worker code with `importTask()` instead
of importing the task function directly into the host. That keeps the code you
want to isolate out of the host process; only the worker imports and runs it.

For example, this runs Bun process workers through Bubblewrap while preserving
the inherited fd:

```ts
const pool = createPool({
  threads: 2,
  worker: {
    runtime: "process",
    processRuntime: "bun",
    processCommandPrefix: [
      "bwrap",
      "--unshare-all",
      "--ro-bind",
      "/",
      "/",
      "--dev-bind",
      "/dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--die-with-parent",
    ],
  },
})({ add });
```

## Permissions

Knitting defaults to a strict worker permission policy:

```ts
permission: { mode: "strict", allowImport: true }
```

That default is meant to be safe enough for normal task imports without giving
workers broad ambient access.

For trusted local scripts, you can opt out:

```ts
const pool = createPool({
  permission: "unsafe",
})({ add });
```

For production or plugin-like workloads, prefer an explicit policy:

```ts
const pool = createPool({
  permission: {
    mode: "strict",
    allowImport: true,
    read: ["./data"],
    write: ["./out"],
    net: ["api.example.com"],
    env: { allow: ["NODE_ENV"] },
    console: true,
  },
})({ add });
```

Permissions are enforced using the runtime features available in Node.js, Deno,
and Bun. The exact mechanics vary by runtime, so treat them as a guardrail, not
as the only security boundary for hostile code.

## Payloads

Worker calls can carry the following values across the shared-memory transport:

- `string`, `number`, `boolean`, `bigint`, `null`, and `undefined`.
- Plain objects and arrays made from supported values.
- `ArrayBuffer`, Node `Buffer`, `DataView`, and supported typed arrays.
- `ProcessSharedBuffer`.
- `Envelope` for metadata plus binary payloads.
- `Error`, `Date`, and global symbols created with `Symbol.for(...)`.
- Native `Promise<supported-value>` inputs. The promise is awaited before
  dispatch.
- Thenables are not awaited by the transport.

If it isn't on that list, assume it isn't portable. Some things don't (or
shouldn't) cross the boundary:

- DOM objects and platform handles.
- Functions, unless they are part of a `task` or `importTask` definition.
- Cyclic object graphs.
- `Map`, `Set`, `WeakMap`, and non-global symbols.
- Objects with behavior that depends on prototypes, getters, setters, or hidden
  process-local state.

If a payload is large, set `payload.maxPayloadBytes` deliberately and prefer
binary/shared-memory shapes over deeply nested objects.

## Shared Memory Channels

`ProcessSharedBuffer` is the lower-level building block for process-safe shared
memory. Use it when two workers or processes need to see the same bytes without
copying the whole payload for every call.

```ts
import { ProcessSharedBuffer } from "@vixeny/knitting/process-shared-buffer";
import { createPool, isMain, task } from "@vixeny/knitting";

export const readFirstCell = task<ProcessSharedBuffer, number>({
  f: (buffer) => Atomics.load(buffer.view(Int32Array), 0),
});

if (isMain) {
  const pool = createPool({ threads: 1 })({ readFirstCell });
  const shared = ProcessSharedBuffer.create(64);

  try {
    Atomics.store(shared.view(Int32Array), 0, 42);
    console.log(await pool.call.readFirstCell(shared));
  } finally {
    shared.close();
    await pool.shutdown();
  }
}
```

### Private parent-child buffers

The default mode is anonymous:

```ts
const shared = ProcessSharedBuffer.create(64);
```

Anonymous buffers are the safest default. They are private handles that are
passed intentionally through Knitting's transport. They are also created with
close-on-exec style hardening where the platform supports it, so unrelated
programs do not accidentally inherit them.

### Named channels for independent processes

Sometimes you do want two unrelated processes to rendezvous on purpose. Use a
named channel for that.

```ts
import { ProcessSharedBuffer } from "@vixeny/knitting/process-shared-buffer";

const name = "knitting-demo-channel";

const owner = ProcessSharedBuffer.create({
  name,
  size: 64,
  mode: "create",
});

try {
  Atomics.store(owner.view(Int32Array), 0, 7);

  const peer = ProcessSharedBuffer.create({
    name,
    size: 64,
    mode: "open",
  });

  try {
    console.log(Atomics.load(peer.view(Int32Array), 0));
  } finally {
    peer.close();
  }
} finally {
  owner.close();
  ProcessSharedBuffer.unlink(name);
}
```

Use `"create"` for the process that owns the channel and `"open"` for peers.
Treat the channel name like a capability: make it unique, do not accept it from
untrusted input without validation, and clean it up when the channel is no
longer needed. On POSIX runtimes `unlink` removes the name. On platforms where
named mappings are lifetime-managed by the OS, closing the last handle is the
important cleanup step.

### Current support

Thread workers are the broadest path: they do not need native prebuilds or FFI.
Process workers and `ProcessSharedBuffer` both use OS-backed shared memory, so
their support follows the native backend for each runtime.

For now, Windows support means thread workers only. Process workers and
`ProcessSharedBuffer` are supported on POSIX targets: Linux and macOS.

| Runtime and target | Thread workers | Process workers | `ProcessSharedBuffer` | Native path |
| --- | --- | --- | --- | --- |
| Node.js 22 / 24 on Linux x64 | Supported | Supported | Supported | Shipped Node `.node` prebuilds. |
| Node.js 22 / 24 on macOS x64 | Supported | Supported | Supported | Shipped Node `.node` prebuilds. |
| Node.js 22 / 24 on macOS arm64 | Supported | Supported | Supported | Shipped Node `.node` prebuilds. |
| Node.js 22 / 24 on Windows x64 | Supported | Not supported | Not supported | Native shared memory is POSIX-only. |
| Other POSIX Node.js ABI or arch | Supported | Local native build needed | Local native build needed | Run `bun run build:native` before using native shared memory. |
| Deno 2+ on Linux/macOS, runtime-supported arch | Supported | Supported | Supported | Uses Deno FFI into libc; allow FFI permission when permissions are enabled. |
| Deno 2+ on Windows | Supported | Not supported | Not supported | Current Deno backend is POSIX-only. |
| Bun 1+ on Linux/macOS, runtime-supported arch | Supported | Supported | Supported | Uses Bun FFI into libc. |
| Bun 1+ on Windows | Supported | Not supported | Not supported | Current Bun backend is POSIX-only. |

## Runtime Safety

Knitting aims to make the safer path the default:

- Strict worker permissions are the default.
- Anonymous shared memory is the default.
- Named shared memory requires an explicit `mode`.
- Payload sizes are bounded.
- Abort-aware tasks reserve shared abort slots.
- Workers can be guarded with `worker.hardTimeoutMs`.
- Shutdown can stop immediately or wait for submitted work with
  `worker.resolveAfterFinishingAll`.

That said, workers still run code. If you treat tasks like plugins, keep
permissions tight, keep named shared-memory names hard to guess, and avoid
passing broad capabilities into worker code.

## Scheduling and Tuning

Choose a balancer based on the shape of your work:

- `"roundRobin"` is simple and works well for similarly sized tasks.
- `"firstIdle"` helps when task durations vary.
- `"randomLane"` is useful for simple spreading and experiments.
- `"firstIdleOrRandom"` prefers an idle worker, then falls back to random.
- `"robinRound"` is kept as a legacy alias of `"roundRobin"`.

Useful tuning options:

- Increase `threads` for parallel CPU-heavy work.
- Increase `payload.payloadMaxByteLength` only when the transport buffer needs
  more room.
- Increase `payload.maxPayloadBytes` only when individual calls genuinely need
  larger payloads.
- Use process workers when isolation matters more than startup cost.

## Benchmarks

```bash
bun run bench
```

The benchmark suite compares scheduling and payload behavior across supported
runtimes. Treat numbers as local guidance: CPU, runtime version, payload shape,
and worker type all matter.

## Development

Install dependencies:

```bash
bun install
```

Build the package:

```bash
bun run build
```

Build the native shared-memory addon on Linux or macOS:

```bash
bun run build:native
```

Run tests:

```bash
npm run test:node
npm run test:deno
npm run test:bun
npm run test:all
```

Emit JSON benchmark results:

```bash
./run.sh --json
```

For a file-by-file orientation, see [map.md](./map.md).

## License

Apache-2.0
