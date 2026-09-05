# knitting

[![JSR Version](https://jsr.io/badges/@vixeny/knitting)](https://jsr.io/@vixeny/knitting)
[![JSR Score](https://jsr.io/badges/@vixeny/knitting/score)](https://jsr.io/@vixeny/knitting)
[![npm Version](https://img.shields.io/npm/v/knitting?logo=npm&logoColor=white)](https://www.npmjs.com/package/knitting)
[![Tests](https://github.com/mimiMonads/knitting/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/mimiMonads/knitting/actions/workflows/test.yml)
[![Coverage Workflow](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml/badge.svg?branch=main)](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml)
[![Coverage](https://img.shields.io/badge/coverage-92.10%25-brightgreen)](https://github.com/mimiMonads/knitting/actions/workflows/coverage.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Node](https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Deno](https://img.shields.io/badge/deno-2%2B-000000?logo=deno&logoColor=white)](https://deno.com/)
[![Bun](https://img.shields.io/badge/bun-1%2B-f472b6?logo=bun&logoColor=white)](https://bun.sh/)

Website: [knittingdocs.netlify.app](https://knittingdocs.netlify.app/)

If you are an agent trying to understand the project, the website also serves an
[`llms.txt`](https://knittingdocs.netlify.app/llms.txt) file with a compact map
of the docs, plus a full inlined version at
[`llms-full.txt`](https://knittingdocs.netlify.app/llms-full.txt).

Knitting is a worker pool built on shared-memory IPC for Node.js, Deno, and Bun.
It lets you call work running on other threads or processes as if it were a
normal async function.

Because calls move through shared memory instead of `postMessage` or sockets,
some workloads can be 5x to 25x faster than the usual worker-message path.

Use it when part of your program should run somewhere else: CPU-heavy work,
bursty small jobs, runtime-isolated code, Docker or bwrap workers, long-running
tools, or cross-runtime process work that still needs to be fast and typed.

You export a function or task, spin up a pool, and call it like a normal async
function:

```ts
const result = await pool.call.resizeImage(file);
```

Most of the time, you only have to take care of four things:

- Export a function or task
- Create a pool
- Call it
- Let `using` or `shutdown()` close the pool

Under the hood, Knitting handles scheduling across worker threads or separate
processes, plus signals, timeouts, lifecycles, memory allocation, cleanup, and
cross-runtime shared memory.

## Why use it?

- Easy to use: spin up threads or processes with a small API.
- Great type support: pass primitives, JSON, promises of those values, and
  special types like typed arrays, `Node Buffer`, `Envelope`, and
  `ProcessSharedBuffer`.
- Runtime flexibility: the same API across Node.js, Deno, and Bun.
- Worker choices: use threads for fast pools or processes for stronger
  isolation.
- Practical defaults: strict worker permissions, payload-size limits, task
  timeouts, abort-aware tasks, and worker hard timeouts.

## Requirements

- Node.js 22+; native features support Node.js 22 and 24 through prebuilt
  addons, and Node.js 26 through experimental `node:ffi`
- Deno 2+
- Bun 1+

See [Platform and native support](#platform-and-native-support) for the prebuild
matrix and the flags native features need.

## Install

From npm:

```bash
npm install knitting
```

For Deno projects:

```bash
deno add --npm knitting
```

## Quick Start

```ts
import { createPool, isMain } from "knitting";

export const square = (value: number) => value * value;

export const greet = (name: string) => `hello ${name}`;

if (isMain) {
  using pool = createPool({ threads: 2 })({ square, greet });

  const [four, message] = await Promise.all([
    pool.call.square(2),
    pool.call.greet("knitting"),
  ]);

  console.log({ four, message });
}
```

Use the `isMain` guard when a module can be loaded by both the host and its
workers. Export tasks at module scope so Knitting can find them, then create and
use the pool only from the main program.

## The Mental Model

There are three core pieces, plus `isMain` for modules that workers may import:

```ts
import { createPool, isMain, task } from "knitting";
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

On TypeScript or runtimes that support explicit resource management, the pool is
also a synchronous disposable:

```ts
if (isMain) {
  using pool = createPool({ threads: 4 })({ add });

  const value = await pool.call.add([1, 2]);
  console.log(value);
}
```

`using` starts pool shutdown when the scope exits and does not wait for it. Use
`await pool.shutdown()` when you need to wait for shutdown or pass a shutdown
delay.

Deno 2+, Bun 1+, and Node.js 24+ parse `using` natively. Node.js 22 does not: it
has `Symbol.dispose`, but the declaration itself is a `SyntaxError`, and Node's
own type stripping (`--experimental-strip-types` /
`--experimental-transform-types`) does not downlevel it, so a `.ts` file with
`using` fails there too. For Node 22, compile the file with TypeScript 5.2+
(`target: "es2022"`), or call `await pool.shutdown()` instead.

For simple tasks that do not need timeout or abort metadata, exported functions
can be used directly:

```ts
export const add = ([a, b]: [number, number]) => a + b;

if (isMain) {
  using pool = createPool({ threads: 1 })({ add });
  console.log(await pool.call.add([1, 2]));
}
```

Bare functions must be exported from the module that creates the pool. Inline
anonymous functions cannot be imported by workers; use `task(...)` when you need
metadata or a more explicit task definition.

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
`ArrayBuffer`, typed arrays, or `ProcessSharedBuffer` instead of serializing big
objects.

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

The signal also carries `signal.now()`, a monotonic millisecond clock for
measuring elapsed time inside the task.

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
import { createPool, importTask, isMain } from "knitting";

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

Imported tasks are never run on the host inline lane, even when the pool enables
the `inliner`. Inlining would evaluate the imported module on the host and
bypass the worker permissions that `importTask` exists to enforce, so Knitting
always routes imported tasks to a worker. You can freely mix `importTask` and
the `inliner` in one pool — regular tasks get inlined while imported ones stay
on worker lanes — but the pool needs at least one worker thread for them to run,
otherwise `createPool` throws.

### Single-task shorthand

For quick scripts, a task can create its own pool:

```ts
import { isMain, task } from "knitting";

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

## Payloads

Worker calls can carry the following values across the shared-memory transport:

- `string`, `number`, `boolean`, `bigint`, `null`, and `undefined`.
- Plain objects and arrays made from supported values.
- `ArrayBuffer`, Node `Buffer`, `DataView`, and supported typed arrays.
- `ProcessSharedBuffer`.
- `BufferReference` from `knitting/unsafe` for experimental zero-copy buffers to
  thread workers (same process only; see below).
- `Envelope` for a JSON header plus a binary body (`ArrayBuffer`,
  `SharedArrayBuffer`, `ProcessSharedBuffer`, or `BufferReference`).
- `Error`, `Date`, and global symbols created with `Symbol.for(...)`.
- Native `Promise<supported-value>` inputs. The promise is awaited before
  dispatch.
- Thenables are not awaited by the transport.

If it isn't on that list, assume it isn't portable. Some things don't (or
shouldn't) cross the boundary:

- DOM objects and platform handles.
- Functions, unless they are exported pool tasks or part of a `task` or
  `importTask` definition.
- Cyclic object graphs.
- `Map`, `Set`, `WeakMap`, and non-global symbols.
- Objects with behavior that depends on prototypes, getters, setters, or hidden
  process-local state.

### Envelope

`Envelope` pairs a JSON-serializable header with a binary body. Use it when a
call needs both structured metadata and raw bytes in a single argument — the
transport carries one special binary value per call, so an envelope is the way
to attach a header to one.

```ts
import { createPool, Envelope, isMain, task } from "knitting";

export const processImage = task<
  Envelope<{ format: string }>,
  Envelope<{ width: number; height: number }>
>({
  f: (envelope) => {
    const pixels = new Uint8Array(envelope.payload);
    // ... process pixels
    return new Envelope({ width: 800, height: 600 }, pixels.buffer);
  },
});

if (isMain) {
  const pool = createPool({ threads: 2 })({ processImage });

  try {
    const buffer = new ArrayBuffer(1024);
    const result = await pool.call.processImage(
      new Envelope({ format: "png" }, buffer),
    );
    console.log(result.header); // { width: 800, height: 600 }
  } finally {
    await pool.shutdown();
  }
}
```

#### Body types

The body is generic — `Envelope<Header, Body>` — and accepts any of the binary
shapes the transport understands:

| Body                  | Copy?             | Workers          | Notes                                                               |
| --------------------- | ----------------- | ---------------- | ------------------------------------------------------------------- |
| `ArrayBuffer`         | copied            | thread + process | The default body; works everywhere.                                 |
| `SharedArrayBuffer`   | zero-copy, shared | thread only      | Shared by reference; process workers reject it.                     |
| `ProcessSharedBuffer` | zero-copy, shared | thread + process | Cross-process shared memory.                                        |
| `BufferReference`     | zero-copy, moved  | thread only      | From `knitting/unsafe`; same constraints as bare `BufferReference`. |

The header keeps its fast paths regardless of the body: a small header is
written inline, and only large headers spill to the dynamic payload region. A
zero-copy body keeps its own semantics — a `SharedArrayBuffer` stays shared by
reference, and a `BufferReference` body is still moved (its source is detached)
and joins the same borrow/copy/release flow it follows on its own.

```ts
import { createPool, Envelope, isMain, task } from "knitting";
import { BufferReference } from "knitting/unsafe";

export const invert = task<
  Envelope<{ op: string }, BufferReference>,
  Envelope<{ op: string }, BufferReference>
>({
  f: (envelope) => {
    const pixels = envelope.payload.toUint8Array();
    const out = new Uint8Array(pixels.length);
    for (let i = 0; i < pixels.length; i++) out[i] = 255 - pixels[i];
    return new Envelope({ op: "inverted" }, new BufferReference(out));
  },
});

if (isMain) {
  using pool = createPool({ threads: 1 })({ invert });
  const pixels = new Uint8Array([0, 64, 128, 192, 255]);

  using result = await pool.call.invert(
    new Envelope({ op: "invert" }, new BufferReference(pixels)),
  );
  console.log(result.header, [...result.payload.toUint8Array()]);
}
```

`Envelope` is disposable: disposing it (via `using` or `Symbol.dispose`)
disposes a disposable body such as a `BufferReference`, and is a harmless no-op
for `ArrayBuffer` / `SharedArrayBuffer` bodies. See
[Large binary values in thread workers](#large-binary-values-in-thread-workers)
for the full `BufferReference` constraints, which apply unchanged to a
`BufferReference` body.

If a payload is large, set `payload.maxPayloadBytes` deliberately and prefer
binary/shared-memory shapes over deeply nested objects.

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

| Option                            | What it does                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `threads`                         | Number of workers to start.                                                                                                       |
| `balancer`                        | Scheduling strategy: `"roundRobin"`, `"firstIdle"`, `"randomLane"`, `"firstIdleOrRandom"`, or the legacy alias `"robinRound"`.    |
| `payload`                         | Shared payload-buffer settings: `mode`, `payloadInitialBytes`, `payloadMaxByteLength`, and `maxPayloadBytes`.                     |
| `abortSignalCapacity`             | Number of shared abort slots available to abort-aware calls.                                                                      |
| `worker.resolveAfterFinishingAll` | Let submitted calls finish before shutdown resolves.                                                                              |
| `worker.bootstrap`                | Privileged async hook imported and awaited before task modules load.                                                              |
| `worker.hardTimeoutMs`            | Force pool shutdown when a task exceeds this many milliseconds.                                                                   |
| `worker.runtime`                  | Choose `"thread"`, `"process"`, or experimental `"compiled"` workers.                                                             |
| `worker.processRuntime`           | Choose `"node"`, `"deno"`, or `"bun"`; standalone `"porffor"` selects compilation and rebuilds once per pool.                    |
| `worker.processSharedMemory`      | Process-worker memory discovery: `"inherit"` by default on Node/Bun POSIX hosts, or `"named"` for wrappers/containers. Deno and Windows hosts use named mappings automatically. |
| `permission`                      | Runtime permission policy for workers.                                                                                            |
| `host.dispatcher`                 | Experimental host dispatcher topology: `"per-thread"` or `"serial-channel"`.                                                      |
| `host.steal`                      | Shared-submit work stealing for compatible multi-worker thread/process pools; enabled by default. Set `false` to use private submit lanes. |
| `debug`                           | Enable diagnostics (`host`, `globals`, `signals`, `imports`, `lifecycle`) or use `KNITTING_DEBUG`.                                |
| `source`                          | Worker source override for advanced runtimes.                                                                                     |

### Worker bootstrap

Use `worker.bootstrap` when a worker needs privileged setup before task modules
are imported. The bootstrap module is imported once per worker, and its selected
export is awaited before Knitting imports task definitions.

```ts
const pool = createPool({
  worker: {
    bootstrap: {
      href: "./worker-bootstrap.ts",
      name: "setup",
      data: { env: "worker-only" },
    },
  },
})({ add });
```

Bootstrap code runs with worker startup privileges, so keep it trusted. It is a
good place to remove environment variables, install runtime guards, open shared
memory metadata, or prepare globals that task modules should see at import time.
Bootstrap is worker-only and cannot be combined with the inline host lane.

## Scheduling and Tuning

### Choosing a balancer

Choose a balancer based on the shape of your work:

- `"roundRobin"` is simple and works well for similarly sized tasks.
- `"firstIdle"` helps when task durations vary.
- `"randomLane"` is useful for simple spreading and experiments.
- `"firstIdleOrRandom"` prefers an idle worker, then falls back to random.
- `"robinRound"` is kept as a legacy alias of `"roundRobin"`.

### Dispatcher and work stealing

Most users can leave `host.dispatcher` alone. It selects the dispatcher for
private-lane pools: Bun and single-worker pools default to `"per-thread"`, while
multi-worker Node/Deno pools use `"serial-channel"`. Selecting a dispatcher or
balancer explicitly preserves that private-lane topology unless
`host.steal: true` is also explicit.

Ordinary multi-worker thread and process pools use shared-submit work stealing
by default. It is not used by one-worker pools, the inliner, compiled/Porffor
workers, or pools with an explicit balancer/dispatcher, so those modes retain
their existing transport. Process workers use one process-shared submit region
and one private return region per process. Pools above the current 31-claimant
protocol limit also fall back. Set `host: { steal: false }` or
`KNITTING_STEAL=0` to opt out for uniformly cheap, low-concurrency workloads
where arbitration has nothing to rebalance. `host: { steal: true }` or
`KNITTING_STEAL=1` forces it for an otherwise compatible pool.

### Useful tuning options

- Increase `threads` for parallel CPU-heavy work.
- Increase `payload.payloadMaxByteLength` only when the transport buffer needs
  more room.
- Increase `payload.maxPayloadBytes` only when individual calls genuinely need
  larger payloads.
- Use process workers when isolation matters more than startup cost.

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
    processRuntime: "deno",
  },
})({ add });
```

`processRuntime` can be `"node"`, `"deno"`, or `"bun"` and defaults to `"deno"`.
Using `processRuntime: "porffor"` is shorthand for the compiled backend and
forces one fresh native build whenever `createPool(...)` is called:

```ts
using pool = createPool({
  worker: { processRuntime: "porffor" },
})({ add });
```

Add `runtime: "compiled"` to reuse a compatible `.knt` instead. Missing or
stale artifacts still build automatically:

```ts
using pool = createPool({
  worker: {
    runtime: "compiled",
    processRuntime: "porffor",
  },
})({ add });
```

You can also provide a `processCommandPrefix` when workers need to be launched
through a wrapper such as a package manager, container command, or runtime shim.

That prefix is also useful for sandbox and resource-control tools. On Node and
Bun POSIX hosts, process workers receive their shared-memory handle on stdin,
which is file descriptor 0. Wrappers that leave stdin alone usually work;
wrappers that replace, close, or proxy stdin without passing the fd through will
stop the worker from booting. Deno-hosted and Windows pools use named mappings
instead.

For wrappers that cannot preserve fd 0, use named process-worker memory instead.
The worker process must share the same OS IPC namespace as the host so it can
reopen the named mapping.

```ts
const pool = createPool({
  threads: 2,
  worker: {
    runtime: "process",
    processRuntime: "node",
    processSharedMemory: {
      mode: "named",
      namePrefix: "knit_worker",
    },
    processCommandPrefix: [
      // The prefix runs before Knitting appends:
      // node --no-warnings --experimental-transform-types <worker-file>
      "docker",
      "run",
      // Remove the container when the worker exits.
      "--rm",
      // Required for named POSIX shared memory across host/container.
      "--ipc=host",
      // The worker imports the same files as the host, at the same path.
      "-v",
      `${process.cwd()}:${process.cwd()}`,
      "-w",
      process.cwd(),
      // Forward Knitting's process-worker boot metadata into the container.
      "-e",
      "KNITTING_PROCESS_WORKER",
      "-e",
      "KNITTING_PROCESS_WORKER_BOOT",
      "knitting-node-worker",
    ],
  },
})({ add });
```

### Experimental compiled workers

A native worker uses the same task declaration and pool call syntax. For a
task module named tasks.ts, Knitting looks for tasks.knt plus tasks.knt.json.
If they are missing, incompatible, or older than the task module, the first
pool builds them automatically with a pinned Porffor compiler; later pools
reuse the validated artifact:

| Worker settings | Compilation behavior |
| --- | --- |
| `runtime: "compiled"` | Reuse a compatible `.knt`; build when missing, stale, or incompatible. |
| `processRuntime: "porffor"` | Select the compiled backend and always rebuild once per pool. |
| `runtime: "compiled", processRuntime: "porffor"` | Reuse a compatible `.knt`; build when missing, stale, or incompatible. |

For example, this bare-function form uses `hello.knt` when it is current:

```ts
import { createPool, isMain } from "knitting";

export const hello = (name: string) => "Hello " + name;

using pool = createPool({
  worker: {
    runtime: "compiled",
    processRuntime: "porffor",
  },
})({ hello });

if (isMain) console.log(await pool.call.hello("World!"));
```

Remove `runtime: "compiled"` from that example when you want a fresh build on
every `createPool(...)`. A multi-worker pool still compiles only once, then
starts every native worker from the resulting artifact.

The `task(...)` declaration form works the same way:

```ts
import { createPool, isMain, task } from "knitting";

export const addOne = task<number, number>({
  f: (value) => value + 1,
});

if (isMain) {
  using pool = createPool({
    threads: 2,
    worker: { runtime: "compiled" },
  })({ addOne });

  console.log(await pool.call.addOne(41)); // 42
}
```

Use worker.compiled.artifact when artifacts live in a build directory:

```ts
const pool = createPool({
  worker: {
    runtime: "compiled",
    compiled: { artifact: "./build/tasks-linux-x64.knt" },
  },
})({ addOne });
```

`worker.compiled.manifest` selects a non-default sidecar location.
`worker.compiled.build` controls generation directly:

- `true` or omitted: build only when the artifact cannot be reused.
- `false`: never build; fail if the prebuilt artifact is unavailable.
- `"always"`: rebuild once whenever a pool is created.

The extension is .knt rather than .out because it identifies a Knitting worker
artifact; executability is never inferred from the suffix alone. Knitting also
requires the sidecar to match the protocol version, current platform and
architecture, source module, source timestamp, and requested task names before
spawning it. `checkCompiledWorker(...)` remains a read-only way to inspect that
state without building or executing anything.

Automatic builds use Porffor main from `worker.compiled.compiler`,
`PORFFOR_MAIN`/`PORF`, or `porf` on PATH. If none exists, Knitting downloads a
pinned compiler into `$XDG_CACHE_HOME/knitting`, or `~/.cache/knitting` when
`XDG_CACHE_HOME` is unset. Native builds use Porffor `-O3` and parallel LTO.
Set `worker.compiled.build: false` for deployment environments that must use
only a prebuilt artifact.

To build ahead of time, run
`bun run build:compiled --module tasks.ts --out tasks.knt --tasks addOne`.

Treat this backend as experimental. Porffor is a young ahead-of-time compiler,
the artifact format is pre-release and changes without a compatibility path, and
the executable is native, unsandboxed code — only run artifacts you trust.

Compiled workers accept synchronous JSON-compatible primitives, arrays, and
plain objects up to 1 MiB per call, plus `ArrayBuffer`, `DataView`, and typed
arrays, which are copied. A `ProcessSharedBuffer` is mapped by the worker rather
than copied. BMP Unicode is supported; supplementary code points and async
results are not.

Abort-aware tasks work on POSIX: the pool shares an abort bitmap through named
shared memory, so `signal.hasAborted()` and `signal.now()` are native reads
inside the worker. Windows has no implementation yet. Task timeouts, bootstrap
hooks, permission policies, and host inlining still fail during pool creation or
invocation; `worker.hardTimeoutMs` remains available because the host enforces
it.

### Deno and Windows process workers

On Windows and when the host is Deno, Knitting automatically uses named shared
memory for the process-worker control channel. You do not need to set
`processSharedMemory: "named"` yourself — the runtime selects it automatically.

```ts
// Works on Windows without extra options.
const pool = createPool({
  threads: 2,
  worker: {
    runtime: "process",
    processRuntime: "node",
  },
})({ add });
```

If you also pass `ProcessSharedBuffer` payloads to Docker workers running on
Windows, create the payload buffer with `mode: "create"` and a name, and add
`--ipc=host` to the Docker prefix — the pool-level control channel is already
named, but the payload buffer needs its own name so the container can reopen it.

When the goal is isolation, define the worker code with `importTask()` instead
of importing the task function directly into the host. That keeps the code you
want to isolate out of the host process; only the worker imports and runs it.

For example, this runs Bun process workers through Bubblewrap while preserving
the inherited fd:

```ts
const pool = createPool({
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

For process workers, that default is translated through the selected runtime's
permission model. If a runtime cannot enforce one of the implicit defaults,
Knitting warns once. Do not treat the default as an OS sandbox.

For trusted local scripts, you can opt out:

```ts
const pool = createPool({
  permission: "unsafe",
})({ add });
```

For production or plugin-like workloads, prefer an explicit policy. This example
is fully representable by a Deno process worker:

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

Before a process worker is spawned, Knitting checks explicit restrictions
against the selected runtime. A restriction that would be broader than requested
or ignored is rejected synchronously. Implicit strict-default gaps remain
backward compatible and produce a once-per-runtime warning.

| Process-worker permission | Deno                | Node 22/24          | Node 26+                   | Bun         |
| ------------------------- | ------------------- | ------------------- | -------------------------- | ----------- |
| Filesystem allow-list     | Scoped              | Scoped              | Scoped                     | Unsupported |
| Filesystem deny-list      | Scoped              | Unsupported         | Unsupported                | Unsupported |
| Network                   | Scoped allow/deny   | Unsupported         | Deny-all or allow-all only | Unsupported |
| Environment allow/deny    | Scoped              | Unsupported         | Unsupported                | Unsupported |
| Child processes           | Scoped allow/deny   | All-or-none         | All-or-none                | Unsupported |
| Worker creation           | Unsupported         | All-or-none         | All-or-none                | Unsupported |
| Import hosts              | Scoped              | Unsupported         | Unsupported                | Unsupported |
| System information        | Scoped              | Unsupported         | Unsupported                | Unsupported |
| WASI denial               | Unsupported         | All-or-none         | All-or-none                | Unsupported |
| Native code / FFI denial  | Transport exception | Transport exception | Transport exception        | Unsupported |

“All-or-none” means an explicit scoped list fails closed. Node 26's
`--allow-net` switch is emitted for `net: true`, but a host allow-list still
cannot be represented. When a wrapper or cross-runtime host hides the target
Node version, Knitting uses the conservative Node 22/24 capability set.

These compatibility checks currently cover process workers. Thread workers use
the host runtime's worker behavior and should not be treated as a sandbox.
Runtime permissions are guardrails, not the only security boundary for hostile
code.

The top-level `ffi` permission is the explicit cross-runtime native-code
capability. On Node it enables both native addons and `node:ffi`; Node's
`--allow-ffi` permission is currently unrestricted. The legacy/runtime-specific
`node.allowAddons` and `node.allowFfi` switches are independent—enabling addons
does not silently enable FFI.

Node process workers are a transport exception: Knitting needs `--allow-addons`
on Node 22/24 or `--allow-ffi` on Node 26 to map their shared memory. Deno
process workers likewise need `--allow-ffi`. Those capabilities apply to the
entire worker process, including task code, so explicit native-code denial fails
closed. Use an OS sandbox when task code is hostile.

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

## Browsers

Knitting also runs in the browser, where the pool spawns web workers over
`SharedArrayBuffer` instead of threads. Two rules apply there and nowhere else.

**The page must be cross-origin isolated.** Browsers hand out
`SharedArrayBuffer` only under these two response headers, and `createPool`
fails with a clear error when they are missing:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Task modules must declare their own URL.** On Node, Deno, and Bun a task
finds its module by walking the stack; a bundler erases the paths that depends
on, so call `setModuleUrl(import.meta.url)` in the module that exports tasks:

```ts
import { createPool, isMain, setModuleUrl, task } from "knitting/browser";

setModuleUrl(import.meta.url);

export const square = task({ f: (value: number) => value * value });

if (isMain) {
  const pool = createPool({ threads: 4 })({ square });
  console.log(await pool.call.square(7)); // 49
  await pool.shutdown();
}
```

Bundle that module with any browser-targeting bundler. The result is
self-hosting: the page loads it, and every worker the pool spawns loads the
same file, which is why both sides agree on the module URL.

`knitting/browser` ships as one self-contained file, so it also works without a
bundler at all — serve it next to a plain task module:

```html
<script type="module" src="./tasks.js"></script>
```

```js
// tasks.js
import { createPool, isMain, setModuleUrl, task } from "./knitting.browser.js";

setModuleUrl(import.meta.url);

export const square = task({ f: (value) => value * value });

if (isMain) {
  const pool = createPool({ threads: 2 })({ square });
  console.log(await pool.call.square(7)); // 49
  await pool.shutdown();
}
```

It is the same API as the main entry without the compiled worker (Porffor)
helpers, which need a filesystem. Process workers, compiled workers, native
addons, FFI, `BufferReference`, and `ProcessSharedBuffer` are all unavailable in
a page, and permissions are skipped rather than enforced — there is no
filesystem or process to police. [BROWSER.md](BROWSER.md) documents every one of
those, with the error each raises.

The published file is bundled and minified, with the Node-only subsystems
(process workers, compiled workers, native addons, FFI, permissions) replaced
by stubs that keep their browser behaviour — roughly 94 KB, 32 KB over gzip.
Both layouts above are covered by the browser test lane:

```bash
npm run build:browser   # build/knitting.browser.js and .min.js
npm run test:browser    # end-to-end checks in headless Chromium
```

## Shared Memory Channels

### Choosing a region or a moved request body

For thread-worker request handlers, `createKnittingAllocator()` can choose the
cheaper representation for each body. Bodies below the HTTP default of 2 MiB
are written into the allocator arena; larger bodies are moved into a
`BufferReference`. The threshold is configurable because the best crossover
depends on request concurrency and the runtime.

`allocOrRefer()` makes that choice without making you handle it. It returns one
disposable handle: send `body.wire` to a task, and the host owns the bytes
until the handle is disposed.

```ts
import { createKnittingAllocator } from "knitting/shared-memory";

const allocator = createKnittingAllocator({
  // Size this for the number of small bodies that may be live at once.
  arenaByteLength: 8 * 1024 * 1024,
});

using body = await allocator.allocOrRefer(request, {
  referenceAboveBytes: 2 * 1024 * 1024,
  maxByteLength: 8 * 1024 * 1024,
});

await pool.call.processBody(body.wire);
```

The worker attaches to the arena once, in a bootstrap module, and then reads
every body the same way whatever transport it took:

```ts
// bootstrap.ts — runs once per worker, before any task module loads.
import {
  createBodyReader,
  type KnittingBodyWire,
  type KnittingTransport,
} from "knitting/shared-memory";

let reader: ((wire: KnittingBodyWire) => Uint8Array) | undefined;

export const setup = (transport: KnittingTransport) => {
  reader = createBodyReader(transport);
};

export const openBody = (wire: KnittingBodyWire): Uint8Array => {
  if (reader === undefined) throw new Error("body reader not attached");
  return reader(wire);
};

// tasks.ts — one signature, whichever way the body arrived.
import { openBody } from "./bootstrap.ts";

export const processBody = task<KnittingBodyWire, number>({
  f: (wire) => digest(openBody(wire)),
});
```

Pass the transport when the pool is built:

```ts
const pool = createPool({
  threads: 4,
  worker: {
    bootstrap: {
      href: "./bootstrap.ts",
      name: "setup",
      data: allocator.transport(),
    },
  },
})({ processBody });
```

The host owns the body for the whole call and the worker only borrows it, so
there is exactly one release and it is the `using` scope. That holds for both
transports, and it holds even if the scope exits early: sending `body.wire`
takes a hold on the body for the duration of the call, so a handler that lets
go before its call settles defers the release rather than freeing memory a
worker is still reading. Nothing needs to call `reconcile()`: the registry
reclaims identities when the next allocation wants them. The bytes a worker
reads are valid only for the duration of the call — to keep them, copy.

`maxByteLength` is required, and enforced at runtime rather than only by the
types, because a declared `Content-Length` is a claim by the client and the
memory is committed on the strength of that claim before a byte arrives. A body
with no declared length is read against the same cap rather than buffered whole
and measured afterwards. Omitting the bound raises a `RangeError` before
anything is read, since this path deliberately allocates outside the arena and
so has no ceiling to fall back on.

`allocOrRefer()` also handles chunked requests without `Content-Length`: it
materializes the body only long enough to choose the representation by its
actual size. `BufferReference` is for same-process thread workers; use
`ProcessSharedBuffer` for process workers.

If you would rather make the choice yourself, the exported
`readBodyOrRefer(request, allocator, options)` returns the underlying
`KnittingSharedBuffer` or `BufferReference` directly and leaves the lifetime to
you — including the hold that `allocOrRefer()` takes for you, so an early
release there really does free the bytes. Sending a region by hand means
picking an ownership rule: `moveTo()` hands the identity to the consumer, which
then releases it, while `describe()` keeps it here and the consumer must adopt
with `{ borrow: true }`. Doing both — describing a region and releasing it here
while the consumer also releases — gives one identity two releasers, which is
the one way to hand a live region's bytes out twice.

`ProcessSharedBuffer` is the lower-level building block for process-safe shared
memory. Use it when two workers or processes need to see the same bytes without
copying the whole payload for every call.

```ts
import {
  getDefaultProcessSharedBufferPrimitives,
  ProcessSharedBuffer,
} from "knitting/shared-memory";
import { createPool, isMain, task } from "knitting";

export const readFirstCell = task<ProcessSharedBuffer, number>({
  f: (buffer) => Atomics.load(buffer.view(Int32Array), 0),
});

if (isMain) {
  const pool = createPool({ threads: 1 })({ readFirstCell });
  const primitives = getDefaultProcessSharedBufferPrimitives();
  const shared = ProcessSharedBuffer.create(64, primitives);

  try {
    Atomics.store(shared.view(Int32Array), 0, 42);
    console.log(await pool.call.readFirstCell(shared));
  } finally {
    shared.descriptor.mapping?.close?.();
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

Use a named channel when two processes need to find the same shared memory
without inheriting an fd from each other. One process creates the channel by
name; the other opens that same name.

```ts
import {
  getDefaultProcessSharedBufferPrimitives,
  ProcessSharedBuffer,
} from "knitting/shared-memory";

const name = "knitting-demo-channel";
const primitives = getDefaultProcessSharedBufferPrimitives();

const owner = ProcessSharedBuffer.create({
  name,
  size: 64,
  mode: "create",
}, primitives);

try {
  Atomics.store(owner.view(Int32Array), 0, 7);

  const peer = ProcessSharedBuffer.create({
    name,
    size: 64,
    mode: "open",
  }, primitives);

  try {
    console.log(Atomics.load(peer.view(Int32Array), 0));
  } finally {
    peer.descriptor.mapping?.close?.();
  }
} finally {
  owner.descriptor.mapping?.close?.();
  primitives.unlinkSharedMemory?.(name);
}
```

Use `"create"` on the owner side and `"open"` on the peer side. The name is the
thing that grants access, so generate a hard-to-guess name and keep it private.
When you are done, close the mappings and unlink the name where the runtime
supports it.

### Sending `ProcessSharedBuffer` to Docker workers

Docker process workers can receive a `ProcessSharedBuffer`, but it needs to be
named. The default anonymous form is fd-backed and private to the parent-child
process path; Docker does not inherit that fd in a way the worker can reopen.

Use a named buffer for the payload and named process-worker memory for the pool:

```ts
import { createPool, isMain, task } from "knitting";
import {
  getDefaultProcessSharedBufferPrimitives,
  ProcessSharedBuffer,
} from "knitting/shared-memory";

export const readCounter = task<ProcessSharedBuffer, number>({
  f: (shared) => Atomics.load(shared.view(Int32Array), 0),
});

if (isMain) {
  const cwd = process.cwd();
  const name = `knitting-docker-counter-${process.pid}`;
  const primitives = getDefaultProcessSharedBufferPrimitives();
  const shared = ProcessSharedBuffer.create({
    mode: "create",
    name,
    size: 64,
  }, primitives);

  const pool = createPool({
    threads: 1,
    worker: {
      runtime: "process",
      processRuntime: "node",
      processSharedMemory: "named",
      processCommandPrefix: [
        // Knitting appends the actual Node worker command after this prefix.
        "docker",
        "run",
        // Named shared memory needs a shared IPC namespace.
        "--ipc=host",
        // Mount the project so the container can import the worker module.
        "-v",
        `${cwd}:${cwd}`,
        "-w",
        cwd,
        // Pass Knitting's boot payload through Docker.
        "-e",
        "KNITTING_PROCESS_WORKER",
        "-e",
        "KNITTING_PROCESS_WORKER_BOOT",
        "node:24-trixie-slim",
      ],
    },
    permission: "unsafe",
  })({ readCounter });

  try {
    Atomics.store(shared.view(Int32Array), 0, 42);
    console.log(await pool.call.readCounter(shared));
  } finally {
    await pool.shutdown();
    shared.descriptor.mapping?.close?.();
    primitives.unlinkSharedMemory?.(name);
  }
}
```

There are three moving parts:

- `processSharedMemory: "named"` lets the Docker worker find Knitting's control
  channel.
- `ProcessSharedBuffer.create({ mode: "create", name, size })` makes the payload
  buffer reopenable by name.
- `--ipc=host` lets the container see the same POSIX shared-memory namespace.

This is same-host communication. It is fast because both sides map the same
bytes, but it is not a network transport and it deliberately shares IPC with the
container. Use names like capabilities: generate them, keep them private, and
unlink them when the shared memory is no longer needed.

### Large binary values in thread workers

Return an ordinary top-level `Uint8Array` or `ArrayBuffer`; there is no wrapper,
manual release, or borrow window. At **256 KiB** and above knitting uses an
ownership move on thread workers:

| Runtime | Result ownership |
| --- | --- |
| Node 22/24 with the addon | The host co-owns the V8 backing store: zero byte copies. |
| Deno and Bun | The host makes one private copy before the worker releases its pin. |
| Older Node backend | The same one-private-copy fallback. |

The worker-side source is detached as it is returned. The host result is private
and stays valid across later calls and pool shutdown. Process workers and small
or non-movable values use the normal payload-copy path.

```ts
export const render = task<number, Uint8Array>({
  f: (size) => {
    const out = new Uint8Array(size);
    out.fill(7);
    return out; // >= 256 KiB: ownership moves automatically
  },
});
```

`BufferReference` remains an advanced, thread-only move handle in
`knitting/unsafe`. Its most useful case is moving an already-owned large
`ArrayBuffer`/typed array into a worker without the host-to-worker copy. Its
source is detached immediately; worker views are valid only for the task call.
Do not accept its metadata from untrusted code. You do **not** need it for
ordinary large return values. See
`docs/buffer-reference-ownership-move.md` for the low-level protocol.

### Experimental zero-copy returns with `sharedBytes` (opt-in)

For an ordinary large return, use the ownership move above. `sharedBytes(n)` is
the explicit alternative when a worker can write directly into the shared arena:
returning it sends only an offset and length, with no copy. In exchange, the
host receives a short-lived borrowed view rather than an owned result.

The borrowed-return path is disabled by default. Enable it explicitly with
`unsafe: { SharedBytes: true }` when creating the pool:

```ts
import { createPool, isMain, task } from "knitting";
import { sharedBytes } from "knitting/unsafe";

export const render = task<number, Uint8Array>({
  f: (size) => {
    const out = sharedBytes(size); // a region of the return arena
    for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
    return out; // returned by reference, not copied
  },
});

if (isMain) {
  using pool = createPool({
    threads: 4,
    unsafe: { SharedBytes: true },
  })({ render });
  const pixels = await pool.call.render(1024 * 1024);
  console.log(pixels.byteLength);
}
```

It is an ordinary `Uint8Array` on both sides — no wrapper type, and nothing
changes about how the task is declared or called.

#### One rule

**Neither side may keep it.** The region is recycled by the worker that lent it.
The worker must not hold it past the return, and the host must copy anything it
needs beyond the next 32 large results on that lane:

```ts
const view = await pool.call.render(size);
const keep = view.slice(); // copy if it outlives the next batch of calls
```

That rule is what makes this fast, and 32 is not an arbitrary number: it is one
full lane of in-flight results, the narrowest window that cannot recycle a
region while its own call is still unread.

#### The region is uninitialized

Like `Buffer.allocUnsafe`, `sharedBytes(n)` hands back memory that still holds
whichever of this worker's earlier returns last used it. You own all `n` bytes:

```ts
const out = sharedBytes(size);
const written = encodeInto(out);   // may be less than `size`
return out.subarray(0, written);   // the tail is never sent
```

Returning a prefix is the cheap way to be safe — a `subarray` of a borrowed
region is still borrowed, so it costs nothing. `sharedBytes(n, true)` zeroes the
region first if you would rather not think about it, but that is a second full
pass over shared memory, and on V8 that pass alone is most of what the feature
saves: at 1 MiB on node it is the difference between 0.9x and 3.2x.

Only `sharedBytes` has this rule. It is deliberately still an unsafe, explicit
arena loan.

#### When it pays

`sharedBytes` is worthwhile only when the worker writes directly into it and
the result is consumed immediately. There is no size threshold that settles it,
because two things move the answer more than size does:

- **The engine matters as much as the size.** V8 has no fast path for byte
  stores into shared memory; JSC shows no difference between shared and heap at
  all. Building a result in shared memory means paying that penalty on V8, so
  the same code can be a solid win on bun and a wash on node. An element-wise
  producer is the worst case; asking for `zeroFill` doubles the exposure.
- **Borrowing trades a copy for a working set.** Every outstanding region is live
  arena, and one lane of 1 MiB returns is 32 MiB of it. Past the point where
  that stops fitting in cache, the host copy you saved costs less than the cache
  misses you bought.

So measure it. `bench/shared-return.ts` interleaves all the arms in one process
for exactly that reason.

#### Arguments, going the other way

`unsafe.SharedArgs` points the same machinery at the request lane:
`pool.sharedArgBytes(n)` gives the host a region of the submit arena to build a
byte argument in, and the worker reads it in place.

```ts
using pool = createPool({ threads: 4, unsafe: { SharedArgs: true } })({ render });

const frame = pool.sharedArgBytes(size);
frame.set(await readChunk());
await pool.call.render(frame);
```

Both borrowed arguments and borrowed returns are opt-in. The asymmetry is the
point: a return is read by the host the moment it arrives, while an argument is read by
task code that may hold it across an `await` — and the region is recycled after
32 further large arguments. **Only turn this on if your tasks finish with their
byte arguments before their first suspension point.**

It also needs the shared submit queue, which is the stealing dispatcher. With a
per-worker dispatcher there is no single arena for the host to build into, so
`sharedArgBytes` returns a plain `Uint8Array` and the call takes the copy path.
That makes it always safe to call, and worth checking `buffer instanceof
SharedArrayBuffer` if you want to know which you got.

Measured at 2 threads with 16 calls in flight, against allocating a fresh buffer
per call: 2.0x at 8 KiB, 13x–27x at 64–256 KiB, and ~100x at 1 MiB, because the
host stops allocating entirely. With a producer that writes every byte
element-wise the win narrows to 2.5x–3.5x on bun and disappears on Node, for the
shared-memory-write reason above.

#### Keeping it off

This is the default. `unsafe.SharedBytes: false` can be used to state the choice
explicitly; borrowed returns stay out of the picture and `sharedBytes` degrades
to a plain `Uint8Array`. Large top-level thread returns still use the safe
ownership path above (zero-copy on the owning Node backend, one host copy on
Deno/Bun); all other results use the normal private-copy path:

```ts
using pool = createPool({
  threads: 4,
  unsafe: { SharedBytes: false },
})({ render });
```

Reach for it when results must stay valid for unbounded time, or to rule the
path out while chasing a bug.

#### Constraints

- **Needs a `SharedArrayBuffer`.** That is the only requirement: no native
  addon, no FFI, and — unlike the pointer payloads — process workers are fine,
  because the arena is mapped in both processes.
- **Bounded by the arena.** A lane has 64 region identities and grows to
  `payload.payloadMaxByteLength` (64 MiB by default). When either runs out,
  returns quietly take the copy path rather than growing without limit.
- **Not a security boundary.** Like everything in `knitting/unsafe`, this hands
  the host a window into a buffer the worker writes. Do not use it as an
  isolation mechanism.
- **A view outlives its worker.** The region lives in the payload arena, which
  the host holds a reference to, so a view read after the worker dies still
  returns the bytes that were there — it does not throw and does not read freed
  memory. It is a snapshot, not a live channel.

## Platform and native support

Knitting supports Node.js 22+, Deno 2+, and Bun 1+ on Linux, macOS, and Windows.

Plain Node thread workers work without native pieces. Node process workers,
`ProcessSharedBuffer`, and `BufferReference` use native support. Release
packages currently include Node prebuilds for:

- Node.js 22 (ABI 127) and Node.js 24 (ABI 137)
- Linux x64
- macOS x64 and arm64
- Windows x64

Odd-numbered Node releases are not supported by packaged native features.
Node.js 26 uses `node:ffi` instead of another ABI-specific addon. Start the host
with:

```bash
node --experimental-ffi app.js
```

When using Node's Permission Model, also grant `--allow-ffi`. Knitting passes
the experimental FFI flag to Node process workers it starts, but the host must
be started with the flag so it can create the shared mappings. The FFI backend
uses external `ArrayBuffer` mappings, so `ProcessSharedBuffer.view()`,
`.getBuffer()`, and `.bytes()` work; `.getSAB()` is available only on the Node
22/24 addon backend.

If you are developing locally on another Node ABI or architecture, you can
compile the current V8 addon for that exact runtime:

```bash
bun run build:native
```

For Deno projects with permissions enabled, allow FFI when using process workers
or `ProcessSharedBuffer`.

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

Build the native shared-memory addon/prebuild for the current platform:

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

Compare inherited-fd and named-shared-memory process-worker startup:

```bash
node --no-warnings --experimental-transform-types bench/startup.ts --named-process-shm
```

For a file-by-file orientation, see [map.md](./map.md).

## License

Apache-2.0
