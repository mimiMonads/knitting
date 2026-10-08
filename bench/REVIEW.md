# Watchdog and benchmark review — 2026-10-08

The watchdog restores dispatcher progress when a completion ring is lost. It
still depends on the host event loop running and a result becoming available.
It does not fix delayed IPC delivery; the Bun/Windows worker yield handles that.

The recovery tests now resolve a published result for both process and native
rings. A separate test checks that a delivered ring causes no later watchdog
wake. The Node doorbell test clears its deadline timer on success and failure.
The Windows probe separates boot from warmed synchronous calls and uses a 750ms
call budget, below the 1s watchdog.

## Benchmark corrections

- Retain task-to-host samples at and above 1s, rather than hiding watchdog stalls.
- Name task-finish timestamps accurately and report invalid clocks and sample counts.
- Warm the full representative workload; one bootstrap call is insufficient for JIT.
- Require the Node addon and grant worker addon permission for native measurements.
  Native and portable Node thread comparisons use matching permissions.
- Report CPU scope and resolve Linux clock ticks rather than assuming 100Hz.
- Keep the same 64-slot configuration when disabling doorbells in the type benchmark.
- Rotate payload variant order, fail on payload mismatches, and give each reused
  copy source its own in-flight slot. Reused SAB sends require one call in flight.
- Grant addon permission consistently in native payload comparisons, which
  otherwise failed under Node's strict worker policy. Correct text ratio headers
  to show the actual division of measured times.
- Emit real JSON from the batch payload/atomic harnesses; separate stderr, reject
  failed or malformed captures, and exclude HTTP server/orchestrator scripts from
  the ordinary runner.
- Report absent host-lag observations as null and cancel the pending probe timer.
  Startup JSON reports failure when no candidate can run.

See [README.md](README.md) for measurement boundaries and interpretation limits.

## Repeated runtime comparison

Environment: Linux x86_64, Intel Core i5-1135G7, Node 24.19.0, Bun 1.4.0.
Compared committed runtime `0aacfd1` with the working-tree watchdog, using the
same corrected harness in both checkouts. Measurements ran sequentially without
concurrent tests. Each configuration had three independent runs per version,
with baseline/current order alternating; each run had one full warmup and three
measured repetitions of 3200 tasks. `DB_BASE=12000`, `DB_STALL_FREE_LOOPS=0`,
`DB_MODE=doorbell`, `DB_TOPOLOGY=steal`; host and process worker runtimes matched.

Values below are medians across the independent runs. Positive throughput change
means faster; positive host CPU per call means more CPU consumed.

| Configuration | Throughput change | Host CPU/call change | p99 round-trip ms, baseline → watchdog |
| --- | ---: | ---: | ---: |
| Node IPC, 1 worker / 1 in flight | -1.7% | +9.7% | 1.541 → 1.553 |
| Bun IPC, 1 worker / 1 in flight | -1.5% | +7.1% | 3.584 → 3.600 |
| Node native, 1 worker / 1 in flight | +0.1% | -1.2% | 1.451 → 1.464 |
| Node atomic, 1 worker / 1 in flight | +0.6% | +0.2% | 1.327 → 1.369 |
| Node IPC, 4 workers / 32 in flight | -0.5% | +7.4% | 6.643 → 6.621 |

Throughput differences in these workloads were below 2%. IPC host CPU per call
increased about 7–10%; the watchdog should not be described as cost-free. Bun
throughput varied substantially (baseline 538–636 ops/s; watchdog 538–572 ops/s),
so three runs do not establish a precise Bun overhead. These results support a
bounded local comparison, not a general claim about every workload or Windows.
All measured process runs retained their 9600 clock samples, with no invalid
clock samples and no task-to-host delays at or above 1s.

Raw captures and the machine-readable summary are in the ignored directory
`bench/data/watchdog-warmed-review/`. The corrected harness is reproducible using
its documented `DB_*` controls; raw artifacts are local and are not shipped.

## Validation

- Full Node suite: 615 passed, 0 failed, 3 skipped. New dispatcher/benchmark tests
  also pass under Bun and Deno; changed TypeScript files pass `deno check`.
- Doorbell, shared-return, shared-return/reference, and reference-send harnesses
  emit valid JSON on Node, Bun, and Deno. Send smoke cases include 64 calls in
  flight, exercising queued source reuse beyond the immediate submission window.
- Owned-return checks pass on all three runtimes; the full one-way reference and
  shared-array-buffer harnesses pass on Node. Reduced standalone copies validate
  atomic-harness JSON on all three runtimes without changing its default workload.
- An isolated corrupted-payload experiment fails and publishes no result JSON.
- An isolated lost-ring experiment with the watchdog still enabled fails the
  750ms process probe, confirming watchdog rescue cannot mask broken notification.
- Host-lag checks with no probe observations report null and exit without waiting
  for the pending 10s probe timer. The park/wake script passes on all three local
  runtimes.

All runtime validation here was on Linux. The probe is ready for Windows, but
this review does not independently reproduce Bun's Windows IPC behavior.
