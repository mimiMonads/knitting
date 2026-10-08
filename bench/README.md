# Benchmark measurements

Run finite top-level benchmarks with `./run.sh`. HTTP servers and the Bun/oha
orchestrator run separately; `bench/core/` and `bench/steal/` contain dedicated
harnesses. Select a finite benchmark and runtime with:

```sh
./run.sh --json --bench=doorbell --runtime=node --results-dir=results/review
```

The runner sorts scripts, runs them sequentially, separates stderr into
`*.stderr.log`, and validates JSON before publishing a result file. A failed run
leaves a diagnostic `*.tmp` capture and preserves any previous successful result.
Check the command's exit status before using captures from an existing directory.

## Doorbell comparisons

`doorbell.ts` runs the full seeded workload for `DB_WARMUP_REPS` (default 1)
before measuring. A single bootstrap call is insufficient to warm the host and
worker JIT paths. `DB_MODE`
selects polling or doorbells; keep every other `DB_*` setting and the host and
worker runtimes identical for an A/B. Unsupported process IPC pairs are rejected
when requesting a doorbell.

```sh
DB_MODE=doorbell DB_WORKER=process DB_PROCESS_RUNTIME=node \
DB_THREADS=1 DB_CONCURRENCY=1 DB_TASKS=3200 DB_REPS=3 \
DB_STALL_FREE_LOOPS=0 ./run.sh --json --bench=doorbell --runtime=node
```

- `p50_latency_ms` and `p99_latency_ms` measure batch-start-to-host-resolution
  time. They include issuing the batch, queueing, task execution, and returns.
- `p50_task_to_host_us`, `p99_task_to_host_us`, and `max_task_to_host_us` measure
  task-finish-to-host-resolution time using an epoch timestamp rounded to 10us.
  They include serialization, waiting for return capacity, and notification.
  They replace the misleading `*_completion_delivery_us` field names; the task
  timestamp is taken before frame publication.
- All nonnegative slow samples are retained. `task_to_host_ge_1s` makes long
  stalls visible; it is not a count of watchdog firings. `invalid_clock_samples`
  counts rejected negative/nonfinite clock differences. Do not compare the
  cross-process percentiles if this count is nonzero.
- `host_cpu_scope` distinguishes host-thread CPU from the host-process fallback.
  Linux thread counters use `getconf CLK_TCK`; they can have coarse resolution.
  CPU is omitted when no usable counter exists. Compare CPU figures only when
  their scopes match.

Thread and process runs return different result shapes to support the process
timestamp. Use each for comparisons within that worker mode. `DB_NATIVE=1`
requires a Node host with thread workers and doorbells enabled. It checks addon
availability and grants the worker addon permission; the strict default would
otherwise silently benchmark the portable path. Native and portable Node thread
runs use matching permissions. Deno's automatic native path can still fall back
if FFI is unavailable; verify that capability separately before comparing it.

The 1s dispatcher watchdog protects liveness; it does not guarantee subsecond
notification. `scripts/check-windows-park.ts` warms the process worker separately
and checks synchronous calls within 750ms. Its 20ms synchronous task gives the
host time to arm, without an async task itself flushing the IPC pipe. Run that
probe on an otherwise quiet Windows machine to validate the Bun yield fix.

## Payload comparisons

`buffer-reference.ts`, `shared-return.ts`,
`shared-return-vs-buffer-reference.ts`, and `buffer-reference-send.ts` rotate
variant order to distribute scheduling and GC drift. The batch harnesses report
batch wall time divided by calls in flight, not individual call latency. Host
payload validation and explicit reference release happen outside that interval.
Their JSON output names that metric and includes sample counts.

Payload mismatches fail the shared-return/send harnesses. The reused-SAB send
variant requires one worker and one call in flight, so a later stamp cannot
overwrite bytes an earlier call is reading. The `ref/raw` variant checks length
only and is a transport upper bound; compare byte-reading variants separately.
The copy, fresh-allocation, reused-SAB, and arena variants intentionally have
different allocation costs. These are end-to-end strategies, not isolated codec
measurements. `owned-return.ts` also includes validation and release in timing.
The reused-copy send variant has a separate source per in-flight call, since
encoding can be deferred by back-pressure.
These harnesses, `owned-return.ts`, and `shared-array-buffer.ts` explicitly allow
Node worker addons for their native payload paths. The default strict worker
policy would reject BufferReference materialization. All variants within a
comparison use the same permission configuration. Text ratio headers show the
actual numerator/denominator of the measured times.

`types_knitting.ts` keeps the same 64-slot setting when disabling doorbells.
`startup.ts` intentionally includes pool creation and first reply, while excluding
shutdown. Its JSON mode exits unsuccessfully when every candidate is skipped.
`withload.ts` creates and shuts down a pool per sample; its distributed result
includes that lifecycle cost. `host-lag.ts` reports missing timer/socket samples
as null, rather than presenting no observations as zero lag.

## Interpreting results

Record the commit, OS, runtime versions, command, and environment overrides with
any result used for a performance claim. Run competing configurations separately
and alternate their order. Avoid running tests or other benchmarks alongside a
measurement. Use repeated independent runs and inspect tails and CPU as well as
throughput; a small smoke run establishes that a harness works, not a speedup.

The harness review covered the dispatcher, startup, host-lag, payload comparisons,
and runner above, plus a static scan of the remaining benchmarks. It is not a
statistical validation of every core microbenchmark or the HTTP/oha system. In
particular, allocation microbenchmarks that only consume `.byteLength` do not
establish the cost of touching every page, and local lock microbenchmarks do not
establish cross-core contention cost. An accepted benchmark result still needs
its workload and units checked against the claim it is used to support.
