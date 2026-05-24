# Knitting Project Map

This is the quick compass for the repo. It lists the files that matter for
understanding, building, testing, and benchmarking the runtime.

## Runtime Shape

The core flow is:

1. A user defines tasks with `task()` or `importTask()`.
2. `createPool()` turns those tasks into callable worker lanes.
3. The host writes calls into shared-memory queues.
4. Workers read calls, execute task functions, and write results back.
5. Payloads move through shared buffers, with special handling for larger or
   non-inline values.

## Public Entry Points

- `knitting.ts`: Main package entry. Re-exports `createPool`, `task`,
  `importTask`, `isMain`, `Envelope`, and `workerMainLoop`.
- `process-shared-buffer.ts`: Secondary public export for process-shared-buffer
  helpers.
- `README.md`: User-facing documentation, examples, configuration, and command
  reference.
- `package.json`: Package metadata, export map, shipped files, scripts, runtime
  engine requirements, and dev dependencies.
- `deno.json`: Deno config used by Deno tests/checks.
- `deno.lock`: Deno dependency lockfile.
- `bun.lockb`: Bun dependency lockfile.
- `LICENSE`: Project license.

## Build And Scripts

- `build.ts`: Bundles `knitting.ts` to `out/` with Bun for a Node ESM target.
- `scripts/build-native-addons.ts`: Compiles the native Node addons into
  `build/Release/` on Linux and macOS. It finds Node headers/libs, splits user
  flags, and builds the shared-memory and futex addons.
- `run.sh`: Runs every top-level benchmark in `bench/` across Node, Deno, and
  Bun. `--json` writes JSON result files.

## Public API Layer

- `src/api.ts`: Defines `task`, `importTask`, `createPool`, `isMain`, task id
  collection, imported task resolution, single-task pool helpers, and typed call
  surfaces.
- `src/types.ts`: Central type model for tasks, pools, worker settings, payload
  settings, permissions, balancing, abort signals, and exported runtime types.
- `src/error.ts`: Shared encoder/runtime error enum and error-construction
  helper.

## Common Utilities

- `src/common/envelope.ts`: `Envelope` wrapper for metadata plus binary
  payloads.
- `src/common/module-url.ts`: Converts file paths and specifiers into importable
  module URLs across platforms.
- `src/common/node-compat.ts`: Safe accessors for Node-only globals and built-in
  modules.
- `src/common/task-source.ts`: Task id generation and caller-file discovery from
  stack frames.
- `src/common/path-canonical.ts`: Canonicalizes paths for permission checks.
- `src/common/runtime.ts`: Runtime detection plus shared-array-buffer creation,
  growth, and WebAssembly-backed fallback support.
- `src/common/shared-buffer-region.ts`: Normalizes whole buffers and sliced
  buffer regions.
- `src/common/shared-buffer-text.ts`: Text encode/decode compatibility probes
  for shared-buffer-backed views.
- `src/common/task-symbol.ts`: Shared symbol used to mark task definitions.
- `src/common/with-resolvers.ts`: `Promise.withResolvers` compatibility helper.
- `src/common/worker-runtime.ts`: Runtime-neutral worker/thread/process-worker
  detection, parent-port access, and message-channel creation.

## Runtime Host Side

- `src/runtime/pool.ts`: Worker spawning and pool construction internals.
  Handles thread workers, process workers, shared-memory layout, child process
  boot, permission propagation, worker errors, and pool shutdown.
- `src/runtime/tx-queue.ts`: Host transmit queue. Encodes calls, tracks pending
  promises, handles backpressure, timeouts, abort metadata, and response
  settlement.
- `src/runtime/dispatcher.ts`: Host dispatcher loop and channel handler. Flushes
  work to workers and drains completed results.
- `src/runtime/balancer.ts`: Lane-selection strategies such as round-robin,
  first-idle, random, and first-idle-random.
- `src/runtime/inline-executor.ts`: Optional in-process executor used by the
  inliner path to run tasks without crossing the worker boundary.

## Worker Side

- `src/worker/loop.ts`: Worker entrypoint and main loop. Boots worker contexts,
  installs safety guards, receives tasks, executes batches, writes completions,
  and supports process-worker bootstrapping.
- `src/worker/task-loader.ts`: Imports task modules inside workers, finds
  exported task definitions, filters by id/caller position, and normalizes
  timeout metadata.
- `src/worker/rx-queue.ts`: Worker receive queue. Decodes pending calls from the
  shared lock and stages them for execution.
- `src/worker/composable-runners.ts`: Builds callable worker runners with abort
  toolkit support, timeout handling, promise handling, and queue-wait budget
  accounting.
- `src/worker/timers.ts`: Worker pause/spin/sleep helpers, including
  `Atomics.wait`, `Atomics.pause`, and native futex integration.

## Worker Safety

- `src/worker/safety/index.ts`: Barrel export for worker safety helpers.
- `src/worker/safety/process.ts`: Blocks direct process termination APIs inside
  workers and silences guarded unhandled rejections.
- `src/worker/safety/performance.ts`: Protects `performance.now()` from worker
  tampering.
- `src/worker/safety/startup.ts`: Validates worker boot data and imported task
  resolution during startup.
- `src/worker/safety/worker-data.ts`: Scrubs sensitive shared-memory references
  from exposed worker data.

## Memory And Payloads

- `src/memory/lock.ts`: Core shared-memory lock protocol. Defines task slots,
  payload markers, bit packing, encode/decode, host resolution, and queue
  mechanics.
- `src/memory/payloadCodec.ts`: Encodes and decodes task inputs/results,
  including strings, binary values, JSON-ish values, errors, promises, symbols,
  `Envelope`, and external payload codecs.
- `src/memory/payload-config.ts`: Normalizes payload-buffer options and enforces
  capacity limits.
- `src/memory/shared-buffer-io.ts`: Low-level binary/text read-write helpers
  over shared buffers.
- `src/memory/regionRegistry.ts`: Allocator/registry for variable-sized dynamic
  payload regions.
- `src/memory/byte-carpet.ts`: Shared-buffer layout helper for aligned regions,
  lock control sectors, and split/interleaved header layouts.

## Shared Abort Support

- `src/shared/abortSignal.ts`: Shared abort-signal bitset helpers used by host
  and worker code to reserve, set, check, and reset abort slots.

## IPC Transport

- `src/ipc/transport/shared-memory.ts`: Small signal channel around shared
  memory. Creates host/worker views and exposes wake/check signals.
- `src/ipc/tools/ring-queue.ts`: Ring queue utility used by queue tests and
  lower-level queue experiments.

## Process And Native Shared Memory

- `src/connections/index.ts`: Barrel export for connection primitives and
  process-shared-buffer types.
- `src/connections/types.ts`: Shared-memory connection contracts, validation,
  alignment helpers, and runtime names.
- `src/connections/process-shared-buffer.ts`: `ProcessSharedBuffer` class,
  metadata serialization, subbuffer views, default primitive selection, and
  payload-codec registration.
- `src/connections/file-descriptor.ts`: File descriptor wrapper, metadata
  parsing, mapping support, and descriptor lifecycle helpers.
- `src/connections/node.ts`: Loads POSIX Node native addons and exposes Node
  shared memory, mapping, unlink, and futex primitives.
- `src/connections/bun.ts`: Bun FFI implementation for POSIX shared memory.
- `src/connections/deno.ts`: Deno FFI implementation for POSIX shared memory.
- `src/connections/posix.ts`: POSIX constants, shared-memory naming, libc path
  detection, and close-on-exec helpers.
- `src/knitting_shared_memory.cc`: Native Node addon for shared-memory create,
  map, unlink, and descriptor operations.
- `src/knitting_shm.cc`: Native Node addon for futex/wait helpers used by parked
  workers.

## Permissions

- `src/permission/index.ts`: Barrel export for permission protocol helpers.
- `src/permission/protocol.ts`: Resolves cross-runtime permission settings into
  Node/Deno/Bun process-worker behavior, including read/write/env/import/process
  policies.

## Benchmarks

- `bench/latency.ts`: Compares basic task-call latency against a direct worker
  postMessage baseline.
- `bench/types.ts`: Compares payload-type behavior between knitting and worker
  messaging.
- `bench/types_knitting.ts`: Knitting-only payload-type benchmark with broader
  type coverage.
- `bench/ipc.ts`: Larger IPC comparison benchmark covering local calls,
  postMessage, HTTP, WebSocket, and knitting.
- `bench/withload.ts`: Measures behavior under main-thread load.
- `bench/call-growth.ts`: Measures call cost as payload size grows.
- `bench/call-growth-batch.ts`: Batch-focused version of call-growth tests.
- `bench/tokio-mpsc-knitting.ts`: Batch latency benchmark for string, number,
  and Uint8Array echo tasks.
- `bench/payload-sweep.ts`: Uint8Array payload-size sweep promoted from the old
  scratch file. Supports table output and `--json`.
- `bench/postmessage/single.ts`: Worker-thread postMessage baseline helper.
- `bench/postmessage/test.go`: Go comparison/experiment for postMessage-style
  IPC.
- `bench/util/json-parse.ts`: Mitata JSON output reducer used by benchmark
  scripts.
- `bench/util/type-payloads.ts`: Shared payload cases and size estimation for
  type benchmarks.

## Core Microbenchmarks

- `bench/core/lock.ts`: Microbenchmarks lock encode/decode/resolve paths.
- `bench/core/loop.ts`: Worker loop behavior under sync, async, and idle gaps.
- `bench/core/inliner.ts`: Inliner threshold and worker-only comparison.
- `bench/core/task-shell.ts`: Task object/shell construction costs.
- `bench/core/regionRegistry.ts`: Dynamic payload region allocator costs.
- `bench/core/object-vs-class.ts`: Object-vs-class shape experiments.
- `bench/core/payload-buffer-vs-uint8array.ts`: Payload backing-store
  comparison.
- `bench/core/payload-hardening.ts`: Payload hardening and strict-object-policy
  costs.
- `bench/core/memory-alloc.ts`: Buffer/ArrayBuffer/Uint8Array allocation
  benchmark.

## Tests

- `test/abortSignal.test.ts`: Shared abort bitset behavior.
- `test/api-cap.test.ts`: API limits such as maximum task id count.
- `test/shared-buffer-io.test.ts`: Shared-buffer IO read/write behavior.
- `test/file-descriptor.test.ts`: File descriptor metadata and mapping behavior.
- `test/inliner.test.ts`: Inline executor behavior and thresholds.
- `test/lock.test.ts`: Core lock protocol, bit packing, encode/decode, and
  allocator behavior.
- `test/loop.test.ts`: Worker loop progress, shutdown delay, and oversized
  batches.
- `test/moduleUrl.test.ts`: Cross-platform module URL normalization.
- `test/parameters.test.ts`: Task parameter passing.
- `test/payload-config.test.ts`: Payload option normalization and limits.
- `test/payloadCodec.test.ts`: Payload codec coverage across primitives,
  buffers, errors, promises, symbols, envelopes, and strict object handling.
- `test/permission.test.ts`: Permission protocol resolution.
- `test/process-shared-buffer.test.ts`: `ProcessSharedBuffer` API and metadata.
- `test/readme-types.test.ts`: README example type-check coverage.
- `test/regionRegistry.test.ts`: Dynamic region registry behavior.
- `test/registerDesync.test.ts`: Register allocator desync stress cases.
- `test/ring-queue.test.ts`: Ring queue behavior.
- `test/runtime.node.test.ts`: Node worker runtime integration and safety tests.
- `test/runtime.process.test.ts`: Process-worker integration across Node, Deno,
  and Bun.
- `test/runtime.shared-buffer.test.ts`: Runtime shared-buffer creation/growth.
- `test/rx-queue.test.ts`: Worker receive queue behavior.
- `test/safety-coverage.test.ts`: Direct safety-guard probe coverage.
- `test/shared-memory-transport.test.ts`: Shared-memory transport offsets.
- `test/task-abort-api.test.ts`: Public abort-signal task API behavior.
- `test/task-abort-context-api.test.ts`: Worker abort toolkit/context behavior.
- `test/tx-queue.test.ts`: Host transmit queue behavior and late-result safety.
- `test/type-inference.test.ts`: Public type inference guarantees.
- `test/fixtures/*.ts`: Task modules used by tests.
- `test/fixtures/probes/*.ts`: Probe programs for crash, permission, process,
  file-descriptor, and shared-memory-corruption safety cases.

## Generated Or External Output

- `build/Release/*.node`: Native addon output produced by
  `scripts/build-native-addons.ts`.
- `out/`: Bundled output produced by `build.ts`.
- `results/`: Benchmark output produced by `run.sh`.
- `node_modules/`: Installed dependencies. Not part of the source map.

## Deleted Or Intentionally Absent

- Browser-mode build/smoke files are no longer part of the project.
- The old top-level scratch files `uwu.ts` and `examples.ts` are removed.
- Python graph scripts under `graphs/` were removed; current benchmark output is
  kept in the TypeScript benchmark suite.
