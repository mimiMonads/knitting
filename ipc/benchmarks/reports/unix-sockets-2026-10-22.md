# Buffer IPC measurements — 2026-10-22

This measures the implementation in `ipc/`, including its inline/arena allocator, publication, consumer loans, retirement and reclamation. It does not reuse the earlier simplified mailbox benchmark. The header/source split preserves the transport behavior.

On this machine, a copied 64 B request plus checksum reply reached **3.15 million completed calls/s** with a **0.281 µs median round trip** (0.340 µs median per-run p99). Persistent Unix sockets reached 198,721 calls/s with a 4.849 µs median round trip. At 32 calls per batch, the IPC completed **11.27 million calls/s** versus 4.55 million for sockets.

IPC waits busy-poll on two pinned cores; sockets use blocking sends/receives. These ratios describe that policy difference along with the actual transport. They do not establish a blocking-channel speedup, low idle CPU, or an advantage over sockets that also share payload memory.

## Copying an existing buffer

Every call includes the request payload, a full-byte worker checksum, a 16-byte response, host validation and buffer release. Calls/s counts completed request/reply pairs, not individual one-way messages. Ratios divide medians of independent runs.

| Payload | Calls/batch | IPC calls/s | Unix socket calls/s | Throughput ratio |
| --- | ---: | ---: | ---: | ---: |
| 64 B | 1 | 3,145,030 | 198,721 | 15.83× |
| 64 B | 32 | 11,266,600 | 4,552,860 | 2.47× |
| 512 B | 1 | 2,572,580 | 195,935 | 13.13× |
| 512 B | 32 | 5,296,720 | 2,874,490 | 1.84× |
| 513 B | 1 | 2,508,770 | 195,977 | 12.80× |
| 513 B | 32 | 6,091,770 | 2,815,710 | 2.16× |
| 4 KiB | 1 | 987,683 | 135,524 | 7.29× |
| 4 KiB | 32 | 1,515,450 | 707,706 | 2.14× |
| 1 MiB | 1 | 5,668 | 2,715 | 2.09× |
| 1 MiB | 32 | 4,640 | 2,320 | 2.00× |

At 64 B/window=1, total host-plus-worker CPU time was 0.635 µs/call for IPC and 7.175 µs/call for sockets. The IPC used approximately two cores during saturated tiny-message runs, despite its lower CPU time per completed call. CPU at idle was not measured.

## Inline/arena boundary

At one call per batch, copied-buffer p50 was 0.351 µs for 512 B inline payloads and 0.361 µs for 513 B arena payloads. The median throughput dropped from 2.57 million to 2.51 million calls/s. At 32 calls per batch, 513 B arena traffic was faster than 512 B inline traffic (6.09 versus 5.30 million calls/s). The storage paths have different queue-retirement, cache and allocation behavior; the two-tier layout does not imply a universal advantage for inline storage. These nearby-size runs are descriptive, not an ablation isolating the effect of storage mode.

## Method and reproducibility

Linux: `Linux-6.5.0-44-generic-x86_64-with-glibc2.38`. CPU: AMD Ryzen 7 4700U. Host/worker pinned and verified on CPUs [0, 1]. GCC 13.2.0 with `-O3 -std=c++20`, separate translation units and no LTO. Five independent runs per configuration, sequential execution, rotated/reversed variant order; no tests or other benchmarks were launched concurrently.

All 200 measured runs and 155,358,080 completed calls validated successfully. Measured run durations: 0.216–0.539 s (median 0.351 s), after up to 1,000 warmup batches. Calibration targeted 0.35 s; shorter/longer runs reflect workload and calibration variation.

`ipc-copy`/`uds-copy` reuse prepared source buffers, stamping one byte per message. `ipc-direct`/`uds-direct` fill every producer byte inside timing: IPC writes into newly reserved shared storage, sockets fill a reused local source before sending. Compare corresponding producer strategies. All consumers read every payload byte on every call.

The socket baseline batches request descriptors into one send, payloads into another, and replies into one send, handling short reads/writes. IPC publishes/retires individual buffers. IPC receives borrow memory; the socket receiver receives payloads into its own reusable buffer. Setup, connection creation, mapping, fork, initial buffers, warmup and cleanup are excluded.

Window=1 gives call round-trip latency. Window=32 gives **whole-batch latency**, not individual call latency. Per-run timer overhead and validation are included. p99 values below are medians of run p99 values; throughput min/max show run variation. There are no confidence intervals or cross-platform guarantees. Fresh unrelated process discovery, FD transfer, failures, many producers and sparse arrivals are outside this experiment.

```sh
python3 ipc/bench.py --repetitions 5 --seconds 0.35 \
  --output results/ipc-reproduction
```

Original raw data, build command, metadata, source hashes and complete source copies: `results/ipc-modular-2026-10-22/` (ignored locally). Source files in `source/` match the measured implementation. The header split was uncommitted during measurement; the base commit is `538a279463f53dfbd25d8269a9ead1ad67da30e0`.

Optimized tests/demo and all seven AddressSanitizer/UndefinedBehaviorSanitizer tests passed after the refactor. Every public header also compiles independently. The sanitizer executable uses non-PIE flags after a PIE sanitizer build repeatedly faulted during sanitizer startup on this host; its optimized build was unaffected.

## Complete measurements

| Bytes | Window | Mode | Calls/s | Min–max calls/s | Batch p50 µs | Batch p99 µs | Total CPU µs/call |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 64 | 1 | uds-copy | 198,721 | 194,995–201,671 | 4.849 | 6.903 | 7.175 |
| 64 | 1 | ipc-copy | 3,145,030 | 3,130,780–3,148,520 | 0.281 | 0.340 | 0.635 |
| 64 | 1 | uds-direct | 196,946 | 195,626–198,249 | 4.859 | 7.154 | 7.220 |
| 64 | 1 | ipc-direct | 3,128,520 | 3,114,350–3,140,100 | 0.281 | 0.350 | 0.639 |
| 64 | 32 | uds-copy | 4,552,860 | 4,426,460–4,742,510 | 5.902 | 9.447 | 0.325 |
| 64 | 32 | ipc-copy | 11,266,600 | 11,149,100–11,334,600 | 2.785 | 3.306 | 0.177 |
| 64 | 32 | uds-direct | 4,048,730 | 3,900,870–4,205,510 | 8.356 | 9.889 | 0.352 |
| 64 | 32 | ipc-direct | 10,974,000 | 10,969,500–11,067,600 | 2.865 | 3.446 | 0.182 |
| 512 | 1 | uds-copy | 195,935 | 192,928–197,429 | 4.899 | 7.273 | 7.374 |
| 512 | 1 | ipc-copy | 2,572,580 | 2,559,510–2,609,200 | 0.351 | 0.431 | 0.777 |
| 512 | 1 | uds-direct | 196,345 | 193,274–198,242 | 4.809 | 7.083 | 7.357 |
| 512 | 1 | ipc-direct | 2,551,760 | 2,543,800–2,595,040 | 0.360 | 0.440 | 0.783 |
| 512 | 32 | uds-copy | 2,874,490 | 2,625,730–2,934,660 | 10.861 | 14.317 | 0.456 |
| 512 | 32 | ipc-copy | 5,296,720 | 5,292,090–5,322,020 | 5.971 | 7.003 | 0.377 |
| 512 | 32 | uds-direct | 2,902,360 | 2,795,940–2,933,680 | 10.529 | 14.457 | 0.479 |
| 512 | 32 | ipc-direct | 5,284,500 | 5,253,360–5,299,670 | 5.991 | 7.023 | 0.378 |
| 513 | 1 | uds-copy | 195,977 | 193,385–202,451 | 4.910 | 6.973 | 7.340 |
| 513 | 1 | ipc-copy | 2,508,770 | 2,393,120–2,510,630 | 0.361 | 0.431 | 0.796 |
| 513 | 1 | uds-direct | 197,677 | 193,614–199,871 | 4.869 | 6.953 | 7.331 |
| 513 | 1 | ipc-direct | 2,495,950 | 2,486,910–2,512,040 | 0.361 | 0.441 | 0.800 |
| 513 | 32 | uds-copy | 2,815,710 | 2,771,170–2,824,260 | 11.031 | 14.767 | 0.461 |
| 513 | 32 | ipc-copy | 6,091,770 | 6,076,940–6,108,230 | 5.189 | 6.022 | 0.328 |
| 513 | 32 | uds-direct | 2,841,370 | 2,757,730–2,903,080 | 10.530 | 15.469 | 0.488 |
| 513 | 32 | ipc-direct | 6,053,470 | 6,036,860–6,086,820 | 5.220 | 6.061 | 0.330 |
| 4096 | 1 | uds-copy | 135,524 | 105,995–137,412 | 7.113 | 10.650 | 10.549 |
| 4096 | 1 | ipc-copy | 987,683 | 981,434–988,769 | 0.972 | 1.202 | 2.023 |
| 4096 | 1 | uds-direct | 132,429 | 130,015–133,771 | 7.084 | 10.490 | 10.707 |
| 4096 | 1 | ipc-direct | 935,920 | 933,783–937,320 | 1.032 | 1.252 | 2.134 |
| 4096 | 32 | uds-copy | 707,706 | 627,569–730,578 | 43.742 | 59.942 | 1.846 |
| 4096 | 32 | ipc-copy | 1,515,450 | 1,501,380–1,524,430 | 21.009 | 23.323 | 1.318 |
| 4096 | 32 | uds-direct | 685,226 | 676,697–710,564 | 45.446 | 58.751 | 1.885 |
| 4096 | 32 | ipc-direct | 1,514,280 | 1,491,520–1,521,900 | 21.000 | 23.444 | 1.319 |
| 1048576 | 1 | uds-copy | 2,715 | 2,137–2,856 | 350.788 | 551.204 | 469.048 |
| 1048576 | 1 | ipc-copy | 5,668 | 5,589–5,715 | 175.780 | 194.846 | 352.370 |
| 1048576 | 1 | uds-direct | 2,511 | 2,213–2,610 | 372.580 | 715.974 | 499.967 |
| 1048576 | 1 | ipc-direct | 5,973 | 5,951–6,016 | 166.773 | 177.503 | 334.380 |
| 1048576 | 32 | uds-copy | 2,320 | 2,247–2,363 | 13817.500 | 14734.000 | 631.550 |
| 1048576 | 32 | ipc-copy | 4,640 | 4,580–4,843 | 6849.660 | 7477.510 | 430.081 |
| 1048576 | 32 | uds-direct | 1,906 | 1,900–1,931 | 16607.000 | 18655.100 | 725.850 |
| 1048576 | 32 | ipc-direct | 5,063 | 4,830–5,084 | 6312.850 | 6778.710 | 394.412 |
