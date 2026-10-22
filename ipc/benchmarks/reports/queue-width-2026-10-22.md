# Quick 32-slot vs 64-slot comparison — 2026-10-22

For 64 B buffers in batches of 64, native 64-bit queue masks delivered **11.22 million completed calls/s**, about **8.2% above the 32-slot build** and **4.72× iceoryx2 0.10.0**. There was no general improvement from widening: single calls and 4 KiB traffic were near unchanged, and the 64-slot build was slower on the large-buffer batches sampled here.

| Payload | Calls/batch | 32-slot calls/s | 64-slot calls/s | iceoryx2 calls/s | 64 / 32 | 64 / iceoryx2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 B | 1 | 3,120,830 | 3,115,020 | 1,094,303 | 0.998× | 2.85× |
| 64 B | 32 | 11,106,700 | 10,928,100 | 2,312,151 | 0.984× | 4.73× |
| 64 B | 64 | 10,371,800 | 11,222,900 | 2,379,019 | 1.082× | 4.72× |
| 4 KiB | 1 | 936,662 | 935,379 | 626,627 | 0.999× | 1.49× |
| 4 KiB | 32 | 1,533,320 | 1,523,690 | 1,027,266 | 0.994× | 1.48× |
| 4 KiB | 64 | 1,546,510 | 1,540,280 | 1,046,514 | 0.996× | 1.47× |
| 1 MiB | 1 | 6,024 | 6,031 | 5,944 | 1.001× | 1.01× |
| 1 MiB | 32 | 5,548 | 5,044 | 5,322 | 0.909× | 0.95× |
| 1 MiB | 64 | 5,146 | 5,012 | 5,277 | 0.974× | 0.95× |

For single 64 B calls, median round trip was 0.281 µs (32-slot), 0.290 µs (64-slot) and 0.862 µs (iceoryx2). These are three short independent runs per case; small differences do not establish a reliable advantage. All configurations spin on separate pinned cores, so this does not measure idle efficiency or blocking wakeups.

## What changed

- `KNITTING_IPC_QUEUE_SLOTS=64` selects a 64-slot layout and a native `atomic<uint64_t>` queue publication/retirement mask. The default remains 32 slots with native 32-bit queue atomics. Both retain separate 64-byte publication and retirement cache lines.
- This is a safe native-width C++ variant, not an exact instruction-level port of `src/memory/lock64.ts`: the JavaScript path uses 64-bit snapshots and 32-bit half-word publication, whereas the C++ variant uses full-width 64-bit atomic loads/stores. No overlapping atomic objects or stealing are introduced.
- The payload arena still has 64 region identities tracked with two 32-bit words in both builds. Inline buffers remain 512 bytes. Mapping format version 2 records queue capacity and rejects an attachment built for the wrong width.
- The benchmark supports batches up to 64 independently of queue capacity. The 32-slot build can service a batch of 64 as the worker drains and replies; it retains only 32 queue slots per direction. All comparisons in a table row use the same total calls per batch.
- iceoryx2 capacities are 32 for windows 1/32 and 64 for window 64: one publisher/subscriber per direction, matching buffer/borrow/loan limits, no history or safe overflow. It uses two pub/sub services through the native Rust API, not its native request/response service.

## Method and checks

AMD Ryzen 7 4700U, Linux 6.5.0-44 x86_64, CPUs 0 and 1. GCC 13.2.0 `-O3`, Rust 1.93.0 release, no LTO. Each producer fills every byte in shared storage; the receiver checksums every byte using the same C++ algorithm, then replies with 16 bytes. Allocation, borrowing, release/reclamation, validation and timing overhead are included. Setup, connection, mapping, fork, initial allocation, warmup and cleanup are excluded.

81 measured runs and 39,975,381 validated calls; durations 0.184–0.412 s after up to 1,000 warmup batches. Three independent runs/configuration, sequential execution, rotating/reversing implementation order and rotating workloads. No tests or other benchmarks ran alongside measurement. Throughput summaries are medians of run metrics, not confidence bounds.

Optimized tests passed for both widths. The 64-slot AddressSanitizer/UndefinedBehaviorSanitizer suite passed, including 20,000 mixed-size cross-process round trips and rejection of an attachment declaring the wrong queue width. The high queue bits, retained inline slots, independent arena releases, cancellation and full-queue retry are exercised.

```sh
make -C ipc test64
python3 ipc/compare_iceoryx.py --wide --repetitions 3 --seconds 0.2 \
  --output results/ipc-wide-reproduction
```

Use a new results directory. Original captures and matching source snapshots/hashes/build commands: `results/ipc-wide-2026-10-22/` (ignored locally). Base commit: `538a279463f53dfbd25d8269a9ead1ad67da30e0`; work was uncommitted. This report compares the narrower C++ SPSC contract against iceoryx2's normal service/sample machinery and its Rust harness; it does not isolate mask width from all architecture effects or establish JavaScript performance.

## Complete measurements

Windows above one report whole-batch latency. p99 is the median of per-run p99 values. CPU is summed across both processes.

| Bytes | Window | Implementation | Calls/s | Min–max calls/s | Batch p50 µs | Batch p99 µs | CPU µs/call |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 64 | 1 | ipc32-direct | 3,120,830 | 3,116,030–3,134,490 | 0.281 | 0.351 | 0.640 |
| 64 | 1 | ipc64-direct | 3,115,020 | 3,112,890–3,130,430 | 0.290 | 0.361 | 0.641 |
| 64 | 1 | iceoryx-direct | 1,094,303 | 1,087,233–1,107,073 | 0.862 | 1.062 | 1.825 |
| 64 | 32 | ipc32-direct | 11,106,700 | 11,013,200–11,189,200 | 2.826 | 3.366 | 0.180 |
| 64 | 32 | ipc64-direct | 10,928,100 | 10,902,700–11,066,500 | 2.876 | 3.436 | 0.183 |
| 64 | 32 | iceoryx-direct | 2,312,151 | 2,287,007–2,325,271 | 13.695 | 15.900 | 0.864 |
| 64 | 64 | ipc32-direct | 10,371,800 | 10,288,200–10,389,200 | 6.091 | 7.244 | 0.193 |
| 64 | 64 | ipc64-direct | 11,222,900 | 11,189,700–11,464,700 | 5.630 | 6.742 | 0.178 |
| 64 | 64 | iceoryx-direct | 2,379,019 | 2,376,344–2,390,912 | 26.630 | 30.518 | 0.840 |
| 4096 | 1 | ipc32-direct | 936,662 | 934,673–938,947 | 1.032 | 1.252 | 2.133 |
| 4096 | 1 | ipc64-direct | 935,379 | 933,098–965,773 | 1.032 | 1.252 | 2.136 |
| 4096 | 1 | iceoryx-direct | 626,627 | 625,672–628,321 | 1.543 | 1.854 | 3.188 |
| 4096 | 32 | ipc32-direct | 1,533,320 | 1,516,760–1,536,500 | 20.709 | 23.253 | 1.302 |
| 4096 | 32 | ipc64-direct | 1,523,690 | 1,506,410–1,528,870 | 20.849 | 23.374 | 1.311 |
| 4096 | 32 | iceoryx-direct | 1,027,266 | 1,021,624–1,032,443 | 30.798 | 34.896 | 1.944 |
| 4096 | 64 | ipc32-direct | 1,546,510 | 1,538,950–1,553,250 | 41.177 | 45.014 | 1.292 |
| 4096 | 64 | ipc64-direct | 1,540,280 | 1,539,780–1,550,810 | 41.318 | 44.984 | 1.297 |
| 4096 | 64 | iceoryx-direct | 1,046,514 | 1,042,050–1,051,021 | 60.694 | 65.593 | 1.909 |
| 1048576 | 1 | ipc32-direct | 6,024 | 6,018–6,037 | 165.361 | 176.942 | 331.502 |
| 1048576 | 1 | ipc64-direct | 6,031 | 6,028–6,044 | 165.310 | 174.989 | 331.182 |
| 1048576 | 1 | iceoryx-direct | 5,944 | 5,943–5,950 | 167.264 | 179.477 | 335.930 |
| 1048576 | 32 | ipc32-direct | 5,548 | 5,471–5,562 | 5761.470 | 6009.610 | 359.781 |
| 1048576 | 32 | ipc64-direct | 5,044 | 5,019–5,469 | 6326.660 | 6704.380 | 395.606 |
| 1048576 | 32 | iceoryx-direct | 5,322 | 5,269–5,336 | 5995.194 | 6318.652 | 374.646 |
| 1048576 | 64 | ipc32-direct | 5,146 | 5,060–5,594 | 12428.100 | 12925.700 | 387.870 |
| 1048576 | 64 | ipc64-direct | 5,012 | 4,977–5,032 | 12728.300 | 13371.400 | 398.229 |
| 1048576 | 64 | iceoryx-direct | 5,277 | 5,213–5,347 | 12107.940 | 12609.232 | 378.169 |
