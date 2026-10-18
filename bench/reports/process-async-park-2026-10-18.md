# Node process async parking: benchmark results

Measured locally on 2026-10-18. IPC async parking substantially improves admission latency and quiet-await CPU use. It does **not** yet satisfy the no-regression goal: synchronous throughput with four stealing workers fell about 38% in longer warmed runs.

Environment: v24.17.0, Linux-6.5.0-44-generic-x86_64-with-glibc2.38, AMD Ryzen 7 4700U with Radeon Graphics; 8 permitted logical CPUs. Baseline is `6c221baf9cb9eb1d4158f5f05fdee5254fcb5130`. Candidate is the working implementation captured in `results/async-park-2026-10-18/candidate.patch`.

## Admission and idle CPU

Three independent runs per configuration, 256 latency samples per run (768 pooled). Every worker was confirmed to hold at least one long pending await. Arrivals have seeded 1–15 ms gaps. Latency is host submit to task start, including enqueue/serialization; it is not an isolated kernel-wake measurement. Percentiles below pool the raw samples. CPU is the median total worker-main-thread CPU time during approximately one second of quiet awaiting.

| Workers | Stealing | p50 before → after (ms) | p99 before → after (ms) | Idle CPU before → after (ms/s) |
| --- | --- | --- | --- | --- |
| 1 | off | 2.033 → 0.286 | 5.256 → 0.574 | 13.52 → 0.15 |
| 1 | on | 1.991 → 0.286 | 5.226 → 0.606 | 13.60 → 0.16 |
| 2 | off | 3.156 → 0.296 | 8.017 → 0.734 | 25.73 → 0.35 |
| 2 | on | 1.377 → 0.296 | 4.573 → 0.704 | 26.39 → 0.36 |
| 4 | off | 4.897 → 0.308 | 10.139 → 0.663 | 49.40 → 0.62 |
| 4 | on | 1.090 → 0.321 | 4.156 → 0.737 | 52.87 → 0.64 |

The old dispatcher armed about 103 backoff timers per worker per second during the quiet interval. The new dispatcher armed **zero in every run**. Idle main-thread CPU fell about 99%. This excludes host CPU and worker helper threads.

## Sparse arrivals

A second experiment uses one worker, stealing off, 60–75 ms arrival gaps, three runs and 128 samples per run (384 pooled). These gaps let the previous backoff reach its 10 ms cap.

| Metric | Before | After |
| --- | --- | --- |
| Submit → task start p50 | 4.520 ms | 0.330 ms |
| Submit → task start p99 | 10.055 ms | 0.627 ms |

The proposal’s p99 <1 ms target is met in these local measurements. The p50 <0.2 ms target is **not** met: candidate medians remain around 0.3 ms. Finite local samples do not establish a cross-platform latency guarantee.

## Synchronous throughput and diagnosis

The initial short throughput samples suggested a regression. Follow-up runs used at least 750 ms warmup and at least 1000 ms measurement per run, in three independent processes per variant/configuration. Work is a trivial synchronous integer task in batches of 64; results are checked. Values are millions of calls per second, median with min–max in parentheses.

The diagnostic variant retains async parking but restores the baseline `src/api.ts`, removing the new parked-peer preference. It is an ablation for this synchronous benchmark; its awaiting-worker wake correctness has not been validated.

| Configuration | Before | Candidate | Candidate with original peer selection | Candidate change |
| --- | --- | --- | --- | --- |
| 1 worker(s), stealing off | 2.854 (2.404–3.053) | 2.407 (2.394–2.452) | 2.384 (2.294–2.950) | -15.7% |
| 4 worker(s), stealing on | 1.098 (0.915–1.127) | 0.680 (0.672–0.684) | 1.028 (0.985–1.037) | -38.1% |

The four-worker result is repeatable, with non-overlapping before/after ranges. Restoring the old peer selection recovers most of that loss, implicating the scan/wake policy. The single-worker measurements vary more and overlap; their median difference alone is weaker evidence of a regression.

The next optimization should preserve synchronous wake selection while ensuring async-parked peers receive work. Simply treating this ablation as a finished fix would skip the awaiting-worker correctness check.

## Scope and reproduction

All runs were sequential; competing variants ran in separate source snapshots, alternating order by repetition. No test suite ran alongside the measurements. Startup/import time was excluded. The original matrix has three runs for each of six configurations and each implementation (36 runs). Follow-ups add 18 longer sync runs and six sparse-arrival runs.

Use [the harness](../process-async-park.ts) and the commands in [bench/README.md](../README.md#awaiting-process-workers). Raw JSON, per-run stderr, exact harness copies and the candidate patch are in `results/async-park-2026-10-18/`; this directory is gitignored. `runs.json` contains the original matrix, `followup-runs.json` contains longer sync and sparse runs, and `metadata.json` records the baseline/environment. Runner scripts are saved alongside them.

Linux `schedstat` measures worker main-thread runtime precisely enough to observe this quiet-await CPU change; it does not include all process threads. Timer instrumentation adds a counter increment to the old polling path. Shutdown timings are recorded in the raw data but include process termination and cleanup, so they cannot establish the proposal’s stop-acknowledgement target. The process-worker path does not support `maxAwaitingTasks: "auto"`; these runs use its default unlimited admission.
