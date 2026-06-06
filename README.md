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

Knitting is a worker pool over a shared-memory IPC runtime for Node.js, Deno,
and Bun. Our mission is to make JavaScript a multicore language with real
inter-runtime communication.

Thanks to its memory design, it can be 5x to 25x faster than using
`postMessages` , bypassing OS socket communication entirely with a novel
protocol written from scratch.

Use it for parts of your program that should run in different environments, such
as CPU-intensive tasks, small jobs, runtime-isolated tasks, custom isolation for
workers in Docker or bwrap environments, long-running tools, or any processes
that require speed and type flexibility.

You export a function or task, spin up a pool, and call it like a normal async
function:

```ts
const result = await pool.call.resizeImage(file);
```

So you only have to take care of 4 things:

- Export a function or task
- Create a pool
- Call it
- Let `using` or `shutdown()` close the pool

Under the hood, we take care of scheduling and orchestration across worker
threads or separate processes, also handling signals, timeouts, life cycles,
memory allocation, garbage collection, and cross-runtime memory over the
processes.

## Why use it?

- Easy to use: Have a multithreaded environment or process with few lines of
  code.
- Great type support: pass primitives, JSON, Promise of these, and special types
  (typed arrays, `Node Buffer`, `Envelope`, and `ProcessSharedBuffer`).
- Runtime flexibility: the same API across Node.js, Deno, and Bun.
- Worker choices: use threads for fast pools or processes for stronger
  isolation.
- All out-of-the-box experiences: strict-by-default permissions, payload-size
  limits, task timeouts, abort-aware tasks, and worker hard timeouts.

## Requirements

- Node.js 22+
- Deno 2+
- Bun 1+

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

The `isMain` guard when the same module is loaded by workers or process. Export
exposes the tasks or functions at module scope, so knitting maps down the
imports, then use and use the pool only from the main program.

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

`using` starts pool shutdown when the scope exits and does not wait for it.
TypeScript 5.2+ can compile this pattern for runtimes that do not parse `using`
syntax directly. Use `await pool.shutdown()` when you need to wait for shutdown
or pass a shutdown delay.

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
| `worker.runtime`                  | Choose `"thread"` or `"process"` workers.                                                                                         |
| `worker.processSharedMemory`      | Process-worker memory discovery: `"inherit"` by default on POSIX, or `"named"` for wrappers/containers that cannot preserve fd 0. |
| `permission`                      | Runtime permission policy for workers.                                                                                            |
| `debug`                           | Enable extra diagnostics.                                                                                                         |
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
You can also provide a `processCommandPrefix` when workers need to be launched
through a wrapper such as a package manager, container command, or runtime shim.

That prefix is also useful for sandbox and resource-control tools. The one
important detail is that process workers receive their shared-memory handle on
stdin, which is file descriptor 0. Wrappers that leave stdin alone usually work;
wrappers that replace, close, or proxy stdin without passing the fd through will
stop the worker from booting.

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

### Windows process workers

On Windows, Knitting automatically uses named shared memory for the
process-worker control channel. You do not need to set
`processSharedMemory: "named"` yourself — the runtime detects Windows and forces
it.

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

| Body                 | Copy?                | Workers          | Notes                                            |
| -------------------- | -------------------- | ---------------- | ------------------------------------------------ |
| `ArrayBuffer`        | copied               | thread + process | The default body; works everywhere.              |
| `SharedArrayBuffer`  | zero-copy, shared    | thread only      | Shared by reference; process workers reject it.  |
| `ProcessSharedBuffer`| zero-copy, shared    | thread + process | Cross-process shared memory.                     |
| `BufferReference`    | zero-copy, moved     | thread only      | From `knitting/unsafe`; same constraints as bare `BufferReference`. |

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
[Experimental zero-copy buffers for thread workers](#experimental-zero-copy-buffers-for-thread-workers)
for the full `BufferReference` constraints, which apply unchanged to a
`BufferReference` body.

If a payload is large, set `payload.maxPayloadBytes` deliberately and prefer
binary/shared-memory shapes over deeply nested objects.

## Shared Memory Channels

`ProcessSharedBuffer` is the lower-level building block for process-safe shared
memory. Use it when two workers or processes need to see the same bytes without
copying the whole payload for every call.

```ts
import {
  getDefaultProcessSharedBufferPrimitives,
  ProcessSharedBuffer,
} from "knitting/process-shared-buffer";
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
} from "knitting/process-shared-buffer";

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
} from "knitting/process-shared-buffer";

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

### Experimental zero-copy buffers for thread workers

`BufferReference` lives in `knitting/unsafe`. It is experimental and may be
changed or removed if its safety tradeoffs are not acceptable. It **moves** a
buffer's ownership to a **thread** worker: constructing one detaches the source,
so the bytes travel to the worker without being serialized through the
transport. Send a result back the same way — return a `BufferReference` from the
worker. It is the same-process counterpart to `ProcessSharedBuffer`: reach for
it when you hold a large `ArrayBuffer` or typed array and the copy cost to a
thread worker actually matters.

```ts
import { createPool, isMain, task } from "knitting";
import { BufferReference } from "knitting/unsafe";

export const invert = task<BufferReference, BufferReference>({
  f: (ref) => {
    const pixels = ref.toUint8Array(); // the moved bytes, no copy
    const out = new Uint8Array(pixels.length);
    for (let i = 0; i < pixels.length; i++) out[i] = 255 - pixels[i];
    return new BufferReference(out); // move the result back to the host
  },
});

if (isMain) {
  const pixels = new Uint8Array([0, 64, 128, 192, 255]);
  using pool = createPool({ threads: 1 })({ invert });

  // `pixels` is detached by the move; the result comes back as a BufferReference.
  const result = await pool.call.invert(new BufferReference(pixels));
  console.log([...result.toUint8Array()]); // [255, 191, 127, 63, 0]
}
```

Read these constraints before reaching for it:

- **Thread workers only.** The handle is a process-local pointer. Process
  workers do not share it, so a `BufferReference` sent to a process worker
  throws. For cross-process sharing use `ProcessSharedBuffer`.
- **ArrayBuffer only.** `SharedArrayBuffer` is already shareable and cannot be
  detached, so `BufferReference` rejects SAB sources and SAB-backed typed-array
  views.
- **Move semantics.** Constructing a `BufferReference` detaches its source — the
  original buffer is empty afterward, and reads/writes through it are gone. The
  bytes now belong to the reference; to get a result back, the worker returns
  its own `BufferReference`. Each handle is one-shot. Forward inputs the worker
  materializes with `.toArrayBuffer()`/`.toUint8Array()` are borrowed for the
  duration of the call and detached once it settles; do not keep using them from
  fire-and-forget work after the task returns.
- **Forward is zero-copy everywhere; the return is zero-copy on Node.** Sending
  a buffer to the worker never copies. On Node the returned buffer is also
  handed back with no copy (the engine co-owns the backing store across
  threads); on Deno and Bun the host takes a single copy of the returned bytes,
  because their FFI cannot co-own a worker-thread backing store. Both are far
  cheaper than serializing a large buffer through the transport.
- **Borrowed Deno/Bun returns are opt-in.** The default is
  `unsafe: { BufferReferenceReturn: "copy" }` — the safe single copy described
  above. Set it to `"borrow"` on `createPool` to skip that copy on Deno/Bun by
  borrowing the worker's backing store until the returned `BufferReference` is
  released. Call `ref.release()` or use `using`, and do it before shutting down
  the producing worker. **After `release()` the borrowed bytes are gone —
  reading the reference, or any view you took from it, is a use-after-free.**
  If the bytes escape into HTTP responses, streams, timers, callbacks, or caches,
  copy them before the borrowed reference is released.
- **Unsafe escape hatch.** This is not a security boundary. Forged metadata or
  unsynchronized host/worker mutation can still be unsafe.
- **Node uses a native addon.** Bun and Deno go through their FFI; Node uses the
  `knitting_buffer_pointer` prebuild shipped with the package (or
  `bun run build:native` when developing on a new ABI). Without it, constructing
  a `BufferReference` on Node throws.

Borrowed returns, end to end (Node is always zero-copy; this opts Deno/Bun in):

```ts
using pool = createPool({
  threads: 1,
  unsafe: {
    BufferReferenceReturn: "borrow",
  },
})({ invert });

{
  using result = await pool.call.invert(new BufferReference(pixels));
  const out = result.toUint8Array(); // borrowed — valid only while `result` lives
  console.log([...out]);
} // `using` releases the borrow here; do not read `out` after this point
```

When in doubt, a plain `ArrayBuffer` or typed-array payload — which knitting
copies through the shared transport — is simpler and works for both thread and
process workers. Reach for `BufferReference` only when the copy cost of a large
buffer to a thread worker actually matters: below roughly 256 KiB the per-call
pointer setup tends to cost more than just copying, so the plain transport wins.

### Current support

Knitting supports Node.js 22+, Deno 2+, and Bun 1+ on Linux, macOS, and Windows.

Thread workers work without native pieces. Process workers and
`ProcessSharedBuffer` use the platform's shared-memory APIs. Release packages
include the native prebuilds needed for the supported Node targets and Windows
FFI path; if you are developing locally on a new Node ABI or architecture, run:

```bash
bun run build:native
```

For Deno projects with permissions enabled, allow FFI when using process workers
or `ProcessSharedBuffer`.

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
