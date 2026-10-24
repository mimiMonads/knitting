# Buffer IPC benchmark

Compare the C++ buffer channel with Unix domain sockets on Linux. Python 3.10+,
a C++20 compiler and two permitted CPUs are required. `CXX` selects the compiler.
Run from the repository root, using a new output directory each time:

```sh
# Correctness only; timings are not performance evidence.
python3 ipc/benchmarks/run.py --wide --smoke --repetitions 1 --output results/ipc-smoke

# Independent measured runs, with LTO enabled for all C++ sources.
python3 ipc/benchmarks/run.py --wide --lto --repetitions 5 --seconds 0.35 \
  --output results/ipc-sockets
```

Each call sends a request, checks every payload byte, returns a 16-byte reply,
validates the ID/checksum and releases its buffer. `copy` stamps and copies a
reused source buffer; `direct` fills every byte in loaned shared storage or a
reused local socket source. Compare matching strategies.

Payloads are 64 B, 512 B, 513 B, 4 KiB and 1 MiB, with windows of 1 and 32 calls.
`--wide` adds a 64-slot build and windows of 64. `--cpus HOST,WORKER` selects two
distinct permitted CPUs; the default uses the first two. IPC busy-polls on two
cores; sockets block and aggregate batch writes. This compares complete workloads,
with different waiting and completion behavior.

Setup, mapping and warmup are excluded. Allocation, payload work, publication,
replies, validation and release are included. Run measurements without competing
benchmark or test jobs. Calls/s counts completed request/reply pairs; windows above
one report whole-batch latency. CPU time sums both processes. Reports summarize
independent runs with medians and throughput ranges.

The runner freezes sources and records compiler/platform details, CPU affinity,
commands, source/binary hashes, raw runs and summaries in the output directory.
Smoke runs check correctness only. Results describe one machine and workload;
they do not establish application throughput or idle efficiency.
