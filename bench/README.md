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

## Awaiting process workers

`process-async-park.ts` compares Node, Bun and Deno process workers holding long awaits. Run
identical copies of the harness against the old and new source, in separate
processes, alternating run order. It confirms that **every** worker holds a
pending await, warms dispatch, then measures quiet idle CPU and arrivals with
seeded gaps of 1–15 ms. Results are JSON; raw latency samples are retained.

```sh
PARK_THREADS=4 PARK_STEAL=true \
  node --no-warnings --experimental-transform-types bench/process-async-park.ts

# Sparse arrivals let the old backoff reach its full 10ms cap.
PARK_SAMPLES=128 PARK_GAP_MIN_MS=60 PARK_GAP_SPAN_MS=16 \
  node --no-warnings --experimental-transform-types bench/process-async-park.ts

# Measure synchronous tasks with longer warmup and measurement windows.
PARK_ONLY_SYNC=true PARK_THREADS=4 PARK_STEAL=true \
PARK_SYNC_WARMUP_MS=750 PARK_SYNC_MIN_MS=1000 \
  node --no-warnings --experimental-transform-types bench/process-async-park.ts

# The worker runtime defaults to the host runtime.
PARK_ONLY_SYNC=true PARK_THREADS=4 PARK_STEAL=true \
  bun run bench/process-async-park.ts
PARK_ONLY_SYNC=true PARK_THREADS=4 PARK_STEAL=true \
  deno run -A --no-check bench/process-async-park.ts
```

Submit-to-task-start uses high-resolution epoch stamps
(`performance.timeOrigin + performance.now()`) across the host and child,
so it includes enqueue, serialization and queueing. Round-trip adds completion
delivery. Neither is an isolated futex/IPC syscall measurement. Sync throughput
uses batches of 64 and validates results. `PARK_SYNC_CALLS` sets the batch-run
size (default 524288); minimum duration settings repeat those runs as needed.
`PARK_WARMUP_CALLS` sets the warmup batch size. `PARK_TASK=immediate` measures
immediately resolved promises; `PARK_TASK=awaited` measures 2 ms awaits.
`PARK_MAX_AWAITING=2` caps admission, and `PARK_WORKER=thread` provides a thread
pool control (`PARK_ONLY_SYNC=true` required). Thread pools also accept
`PARK_MAX_AWAITING=auto`. The `sync_*` output fields report the selected task's
throughput, including when that task awaits.

Local duration measurements use `process.hrtime.bigint()`. Its process-relative
origins on Bun/Deno make it unsuitable for cross-process task-start stamps.
The harness rejects negative admission samples and samples exceeding their
round-trip duration; it does not clamp or discard them. Epoch comparisons still
depend on the machine clock staying stable between host and worker startup.
`PARK_PROCESS_RUNTIME` selects the child runtime.
`PARK_WORKER_CPUS=1,2,3,4` pins process workers after
boot and verifies their affinity; pin the host separately with `taskset -c 0`.

On Linux, idle CPU uses `/proc/<pid>/schedstat` for **worker main threads**,
summed across workers; it excludes helper threads and host CPU. On other
platforms, CPU and affinity fields are omitted. Backoff timer counts observe the
child's 1–10 ms timers during a quiet interval, excluding the long task timers,
and admission/round-trip latency works on Windows too. Shutdown time includes
process termination and cleanup, so it does not measure just stop
acknowledgement. `PARK_WORKER_CPUS` is Linux-only.

On Windows, run the harness before and after the change with identical runtime,
worker count, task kind, and sample settings. For example, these commands
measure an async-heavy process pool and a sync-only control:

```powershell
$env:PARK_THREADS = "4"
$env:PARK_TASK = "awaited"
bun run bench/process-async-park.ts
Remove-Item Env:PARK_TASK
$env:PARK_ONLY_SYNC = "true"
bun run bench/process-async-park.ts
```

Repeat with `node --no-warnings --experimental-transform-types` or
`deno run -A --no-check` to compare hosts. Windows has no worker CPU counter in
this harness, so use the quiet-period timer count and arrival latency as the
portable evidence; the `check:windows-park` probe also checks warmed synchronous
calls against the 1s watchdog.

Results: [initial async parking](reports/process-async-park-2026-10-18.md) and
[runtime regression check](reports/process-async-regression-2026-10-18.md).
The latter covers the current async-only wake policy, the Deno completion-flush
fix, and the remaining measured Bun immediate-promise cost.

## Compare against the published npm release

`npm run bench:compare` builds the local JavaScript and native addons, resolves
`knitting@latest` once, and compares the two packaged snapshots in isolated Node
processes. It requires Node 22/24 on a supported native target, npm, Bun, and a C++
compiler. The native build updates the current platform's prebuild in the working
tree. Dependencies of the two snapshots install in temporary directories with
lifecycle scripts disabled; the runner removes those directories after completion.

```sh
npm run bench:compare
# Short harness smoke check; timings are not a performance conclusion.
npm run bench:compare -- --repetitions 2 --iterations 30 --warmup 10 --memory-buffers 24
# Pin the baseline for subsequent comparisons.
npm run bench:compare -- --baseline 0.1.77 --repetitions 7
```

Each invocation creates a new `results/release-comparison/TIMESTAMP-PID/` directory:

- `report.md`: readable correctness, timing, and memory comparison.
- `summary.json`, `summary.csv`: machine-readable results. JSON also includes raw run results.
- `metadata.json`: exact published version, registry integrity, SHA-256 hashes of
  both tarballs, source commit/dirty status, runtime, CPU, OS, and workload options.
- `runs/`: raw timings, memory checkpoints, correctness checks, stdout, and stderr
  for each version and repetition. Failed runs keep partial captures.
- `packages/`: the exact tested tarballs, installation lockfiles, and generated
  workload modules. Generated modules record temporary paths; use the checked-in
  template and runner to reproduce a run rather than executing those copies.
- `logs/`: build, registry, packaging, and installation diagnostics.

The workflow **Compare with published release** is manually dispatched and uploads
these files as a downloadable artifact, including when a workload fails. It also
puts the report in the job summary. No performance threshold blocks a run;
correctness failures and missing/invalid results exit nonzero. It is separate from
ordinary unit tests, which stay offline with respect to the npm baseline.

Five workloads measure warm scalar calls, reused/fresh 1 MiB shared inputs,
copied 1 MiB inputs, and 4 KiB mappings. Payload validation touches every 4 KiB
page and the final byte. A separate workload returns fresh 1 MiB shared buffers
and records memory growth after requested GC, before shutdown and after shutdown.
RSS includes worker memory and allocator retention; memory growth is diagnostic,
not proof of a leak. Security regression tests run separately against local code,
because failing those tests is expected for an affected older release.

Versions alternate order between repetitions, and workload order rotates. The
report compares medians of independent run medians; p99 values are medians of
per-run p99 values. Positive timing changes mean local is slower. Keep the
machine quiet, inspect raw samples, and increase repetitions before treating a
small difference as meaningful. Use `--help` for options, including `--output`
(which must name a new directory) and `--skip-build` (requires an already current
JavaScript **and native** build).
