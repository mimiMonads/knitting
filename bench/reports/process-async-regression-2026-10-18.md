# Async parking regression check — 2026-10-18

A real Deno regression was found and fixed: buffered completion rings caused watchdog-sized stalls in synchronous private pools. No consistent pure-synchronous throughput loss appeared in the sampled private/shared process pools. Bun immediate promises retain a small measured cost: −2.0% in the longer confirmation (all three pairs lower). This is not a claim of zero overhead.

Baseline: `6c221ba`. Candidate: the working-tree async parking implementation, including Node/Bun/Deno parity and the Deno completion-flush fix below.

Environment: Linux-6.5.0-44-generic-x86_64-with-glibc2.38; AMD Ryzen 7 4700U with Radeon Graphics; v24.17.0, 1.4.3, deno 2.5.6 (stable, release, x86_64-unknown-linux-gnu).

## Confirmed regression and fix

The first Deno four-worker private-lane synchronous benchmark timed out after 90 seconds; the original baseline completed. A shorter reproduction also timed out during warmup. Deno buffers `process.send()` writes until the event loop gets a turn, but the worker returned directly to synchronous polling after publishing a result. The host then depended on its one-second completion watchdog.

The worker now yields after a Deno process completion ring, matching the existing Bun/Windows flush rule. This applies only to process IPC completion notifications. The same reproducer now completes, and a regression test repeatedly submits synchronous batches to a directly armed host, with a 500 ms batch deadline below the one-second watchdog. That test passes for all nine host/child combinations.

## Measurement method

Three independent, interleaved before/after pairs per configuration, using the identical harness against isolated source snapshots. Each run warms the selected workload for at least 300 ms and measures for at least 600 ms. Calls use batches of 64 and every result is validated. Awaited tasks sleep for 2 ms. Process-pool hosts are pinned to CPU 0 and child main threads to CPUs 1–4 (CPU 1 for a single worker). Thread controls share CPU mask 0–4 between host and workers. Measurements run sequentially, without concurrent tests.

Changes below are the median of the three paired throughput ratios; before/after columns are separate medians, so their ratio can differ. Positive means faster. The last column shows the full range of paired changes, making run-to-run variation visible. No equivalence margin or statistical confidence interval is established by three pairs.

Node/Bun throughput rows were measured before the Deno-only flush fix; the affected branch is false for those matching-runtime workers. Deno rows and all quiet-await latency/CPU samples use the fixed source. Both source patches and their hashes are retained. Mixed-runtime throughput, large payloads and other worker counts were not benchmarked. Deno thread auto admission is unsupported on both revisions and was excluded from that control.

## Throughput

| Runtime | Configuration | Before calls/s | After calls/s | Paired change | Paired range |
| --- | --- | ---: | ---: | ---: | ---: |
| node | process-private-1 | 2,557,627 | 2,695,526 | +2.7% | -1.1% to +10.0% |
| node | process-private-4 | 774,861 | 773,602 | +1.6% | -0.2% to +3.5% |
| node | process-shared-4 | 1,012,603 | 1,084,064 | +7.1% | -4.3% to +22.3% |
| node | thread-shared-4 | 502,796 | 557,751 | +10.1% | +0.4% to +12.0% |
| node | process-immediate-4 | 1,500,026 | 1,466,752 | -2.3% | -9.9% to +9.8% |
| node | process-await-cap2-4 | 3,467 | 3,454 | -0.4% | -1.2% to +1.7% |
| node | thread-await-auto-4 | 17,491 | 17,588 | +3.1% | -9.1% to +8.9% |
| bun | process-private-1 | 29,168 | 29,574 | +1.1% | +0.8% to +2.4% |
| bun | process-private-4 | 47,256 | 49,099 | +4.8% | +0.7% to +5.1% |
| bun | process-shared-4 | 163,568 | 160,732 | +5.2% | -4.1% to +15.4% |
| bun | thread-shared-4 | 709,292 | 636,847 | -10.2% | -66.5% to +25.0% |
| bun | process-immediate-4 | 160,327 | 151,464 | -5.8% | -12.5% to -4.2% |
| bun | process-await-cap2-4 | 3,508 | 3,466 | -1.2% | -1.7% to +3.9% |
| bun | thread-await-auto-4 | 19,666 | 19,144 | -2.6% | -10.6% to +2.4% |
| deno | process-private-1 | 26,733 | 26,584 | -0.6% | -3.6% to +1.0% |
| deno | process-private-4 | 35,199 | 49,756 | +40.7% | +37.6% to +45.6% |
| deno | process-shared-4 | 28,349 | 28,373 | -1.1% | -2.0% to +2.4% |
| deno | thread-shared-4 | 109,022 | 89,982 | +3.9% | -45.2% to +17.3% |
| deno | process-immediate-4 | 13,435 | 13,449 | -0.2% | -0.5% to +0.3% |
| deno | process-await-cap2-4 | 1,818 | 2,294 | +26.9% | +25.4% to +27.4% |

## Longer confirmation

Rows with an initial median throughput drop greater than 5% received one longer pass: three further interleaved pairs, at least 750 ms warmup and 1,500 ms measurement. The original candidate snapshot is retained for those comparisons.

| Runtime | Configuration | Median paired change | Individual pairs |
| --- | --- | ---: | --- |
| bun | thread-shared-4 | +10.3% | -3.7%, +41.9%, +10.3% |
| bun | process-immediate-4 | -2.0% | -1.3%, -2.0%, -2.7% |

## Quiet pending awaits

Admission stamps use `(performance.timeOrigin + performance.now()) * 1000`; round trips and throughput use local `hrtime` differences. Initial Bun/Deno cross-process `hrtime` samples were invalid because their origins differed. Those admission results were excluded and this entire idle/latency section was rerun with epoch stamps, rejecting any admission outside its measured round trip. Epoch comparisons still depend on the machine clock staying stable between host and child startup. No throughput results were affected by that clock error.

One before/after run per runtime and worker count, with every process worker holding a long await. Each run observes 500 ms quiet idle time and 64 seeded arrival gaps of 11–16 ms. The p99 with 64 samples is the maximum sample, so these figures are descriptive, not a reliable tail bound. CPU covers child main threads only; it excludes host and helper threads.

| Runtime / workers | Admission p50 µs, before → after | Admission p99 µs, before → after | Worker CPU ms, before → after | Backoff timers/s, before → after |
| --- | ---: | ---: | ---: | ---: |
| node / 1 | 3249.8 → 323.8 | 6019.2 → 895.2 | 5.40 → 0.23 | 108 → 0 |
| node / 4 | 1511.8 → 263.8 | 4947.0 → 516.0 | 22.26 → 0.38 | 464 → 0 |
| bun / 1 | 3228.5 → 113.8 | 6084.5 → 473.5 | 4.71 → 0.02 | 108 → 0 |
| bun / 4 | 1613.2 → 125.8 | 5400.0 → 537.0 | 11.55 → 9.03 | 451 → 0 |
| deno / 1 | 2715.5 → 393.0 | 5992.8 → 800.0 | 4.83 → 0.26 | 98 → 0 |
| deno / 4 | 1370.0 → 404.0 | 5909.0 → 973.2 | 20.84 → 1.12 | 391 → 0 |

## Validation

Build passes. The relevant process, stealing and adaptive-admission suites pass on all three hosts after the fix: Node 133 passed / 1 skipped; Bun 131 passed / 3 skipped; Deno 125 passed / 9 ignored. Zero failures. This includes the new repeated synchronous completion-ring regression test across all nine runtime pairs.

## Artifacts

Local raw artifacts: `results/runtime-regression-2026-10-18/` (132 matrix runs plus 12 confirmation runs). This ignored directory includes metadata, the original and fixed source patches, throughput and corrected-latency harnesses (identical between variants within each measurement), runners, individual JSON/stderr captures, aggregate `runs.json`, and the stalled/fixed Deno reproduction logs.

Original source patch SHA-256: `3d7a0d378e106ec852c33fce3fdd8121bc398163476475f8282965c435ae6333`. Fixed source patch SHA-256: `33a11ab88d77b680559b60830d2352910c506ec961e474f7482b69d1162a63b6`.
